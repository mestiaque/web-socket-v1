import { createServer } from 'node:http';
import { once } from 'node:events';
import { AppRegistry } from './auth/app-registry.js';
import { InMemoryBus } from './adapters/in-memory-bus.js';
import { assertMessageBus } from './adapters/message-bus.js';
import { ChannelManager } from './channels/channel-manager.js';
import { PresenceManager } from './channels/presence-manager.js';
import { SubscriptionRegistry } from './channels/subscription-registry.js';
import { createRouter } from './http/router.js';
import { Broadcaster } from './messaging/broadcaster.js';
import { createLogger } from './observability/logger.js';
import { Metrics } from './observability/metrics.js';
import { KeyedRateLimiter, perMinute } from './security/rate-limiter.js';
import { ExpiringKeyStore } from './security/replay-protection.js';
import { ConnectionTracker } from './websocket/connection-tracker.js';
import { attachWebSocketServer } from './websocket/create-server.js';
import { Heartbeat } from './websocket/heartbeat.js';
import { CloseCode } from './websocket/protocol.js';
import { instanceId } from './utils/ids.js';

/**
 * Wires all modules together. Returns a handle with start()/stop() so tests
 * can run real servers in-process on ephemeral ports.
 *
 * @param {object} config result of loadConfig()
 * @param {{ logger?: object, bus?: object }} [deps]
 */
export function createDynamicSocket(config, deps = {}) {
  const logger = deps.logger ?? createLogger({ level: config.logLevel, base: { instanceId } });
  const metrics = new Metrics();
  const registry = new AppRegistry(config.apps);
  const subscriptions = new SubscriptionRegistry();
  const broadcaster = new Broadcaster({ registry: subscriptions, maxBufferedBytes: config.limits.maxBufferedBytes, metrics, logger });
  const presence = new PresenceManager({
    maxMembers: config.limits.maxPresenceMembers,
    leaveGraceMs: config.timeouts.presenceLeaveGraceMs,
    notify: (appId, channel, message, excludeSub) => {
      metrics.inc('ds_presence_changes_total', { app: appId, action: message.action });
      broadcaster.sendToChannel(appId, channel, message, excludeSub);
    },
  });
  const channels = new ChannelManager({
    maxSubscriptionsPerConnection: config.limits.maxSubscriptionsPerConnection,
    registry: subscriptions,
    presence,
  });
  const connections = new ConnectionTracker();
  const bus = assertMessageBus(deps.bus ?? new InMemoryBus());
  let shuttingDown = false;

  const ctx = {
    config,
    logger,
    metrics,
    registry,
    channels,
    connections,
    bus,
    startedAt: Date.now(),
    isShuttingDown: () => shuttingDown,
    nonceStore: new ExpiringKeyStore({ maxEntries: config.signatures.nonceStoreMax }),
    jtiStore: new ExpiringKeyStore({ maxEntries: config.signatures.nonceStoreMax }),
    upgradeLimiter: new KeyedRateLimiter(perMinute(config.rateLimits.upgradesPerIpPerMinute)),
    authFailureLimiter: new KeyedRateLimiter(perMinute(config.rateLimits.authFailuresPerIpPerMinute)),
    signatureFailureLimiter: new KeyedRateLimiter(perMinute(config.rateLimits.authFailuresPerIpPerMinute)),
    publishLimiter: new KeyedRateLimiter({ perSecond: config.rateLimits.publishPerSecond, burst: config.rateLimits.publishBurst }),
  };

  bus.subscribe((message) => broadcaster.deliver(message));

  metrics.gauge('ds_connections', 'Open WebSocket connections', () => connections.size);
  metrics.gauge('ds_connections_by_app', 'Open WebSocket connections per app', () =>
    [...connections.byApp].map(([app, n]) => [{ app }, n]),
  );
  metrics.gauge('ds_channels', 'Channels with at least one subscriber', () => channels.registry.channels.size);
  metrics.gauge('ds_nonce_store_size', 'Entries in the request nonce store', () => ctx.nonceStore.size);

  const httpServer = createServer(createRouter(ctx));
  httpServer.requestTimeout = config.timeouts.httpRequestTimeoutMs;
  httpServer.headersTimeout = config.timeouts.httpHeadersTimeoutMs;
  httpServer.keepAliveTimeout = config.timeouts.httpKeepAliveTimeoutMs;
  httpServer.on('clientError', (err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
    else socket.destroy();
  });

  const wss = attachWebSocketServer(httpServer, ctx);
  const heartbeat = new Heartbeat({ connections, intervalMs: config.timeouts.heartbeatIntervalMs, metrics, logger });

  const sweeper = setInterval(() => {
    const now = Date.now();
    ctx.nonceStore.sweep(now);
    ctx.jtiStore.sweep(now);
    ctx.upgradeLimiter.sweep(now);
    ctx.authFailureLimiter.sweep(now);
    ctx.signatureFailureLimiter.sweep(now);
    ctx.publishLimiter.sweep(now);
  }, 30_000);
  sweeper.unref();

  async function start() {
    httpServer.listen(config.port, config.host);
    await once(httpServer, 'listening');
    heartbeat.start();
    // Process managers such as Phusion Passenger (cPanel) redirect listen()
    // to a Unix socket, in which case address() is a path string.
    const bound = httpServer.address();
    const { address, port } = typeof bound === 'object' && bound !== null ? bound : { address: bound, port: null };
    logger.info('DynamicSocket listening', { address, port, wsPath: config.wsPath, apps: registry.ids() });
    return { address, port };
  }

  /**
   * Graceful shutdown: refuse new work, ask clients to go away (1001), wait
   * up to shutdownTimeoutMs, then terminate whatever is left.
   */
  async function stop() {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info('shutting down', { connections: connections.size });
    heartbeat.stop();
    clearInterval(sweeper);

    const serverClosed = new Promise((resolve) => httpServer.close(() => resolve()));
    httpServer.closeIdleConnections();

    for (const conn of connections) conn.close(CloseCode.GOING_AWAY, 'server_shutdown');
    await waitUntilEmpty(connections, config.timeouts.shutdownTimeoutMs);
    if (connections.size > 0) {
      logger.warn('terminating connections after shutdown timeout', { remaining: connections.size });
      for (const conn of connections) conn.ws.terminate();
      // terminate() destroys sockets; 'close' handlers run on a later tick.
      await waitUntilEmpty(connections, 1000);
    }
    presence.dispose();
    httpServer.closeAllConnections();
    wss.close();
    await bus.close();
    await serverClosed;
    logger.info('shutdown complete');
  }

  return { start, stop, ctx, httpServer, address: () => httpServer.address() };
}

async function waitUntilEmpty(connections, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (connections.size > 0 && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
}
