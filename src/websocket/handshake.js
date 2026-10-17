import { STATUS_CODES } from 'node:http';
import { checkOrigin } from '../auth/origin-policy.js';
import { clientIp } from '../utils/client-ip.js';

/**
 * Pre-handshake checks performed on the raw HTTP Upgrade request, before any
 * WebSocket resources are allocated. Rejections are written as plain HTTP
 * responses and the socket is closed.
 *
 * Order: path -> shutdown -> per-IP upgrade rate -> app -> origin ->
 *        global/app/IP connection limits.
 *
 * @returns {{ ok: true, app: object, ip: string, origin: string|undefined } | { ok: false }}
 */
export function checkUpgrade(req, socket, ctx) {
  const { config, metrics } = ctx;
  const reject = (status, code) => {
    metrics.inc('ds_upgrades_rejected_total', { reason: code });
    rejectUpgrade(socket, status, code);
    return { ok: false };
  };

  let url;
  try {
    url = new URL(req.url, 'http://localhost');
  } catch {
    return reject(400, 'bad_request');
  }
  if (url.pathname !== config.wsPath) return reject(404, 'not_found');
  if (ctx.isShuttingDown()) return reject(503, 'shutting_down');

  const ip = clientIp(req, config.trustedProxies);
  if (!ctx.upgradeLimiter.take(ip)) return reject(429, 'rate_limited');

  const appId = url.searchParams.get('app');
  if (!appId) return reject(400, 'app_required');
  const app = ctx.registry.get(appId);
  // Unknown apps get the same response as disallowed origins.
  if (!app) return reject(403, 'forbidden');

  const origin = req.headers.origin;
  const originResult = checkOrigin(app, origin);
  if (!originResult.ok) {
    ctx.logger.info('upgrade rejected by origin policy', { appId, ip, reason: originResult.reason, origin: origin?.slice(0, 200) });
    return reject(403, 'forbidden');
  }

  const { connections } = ctx;
  if (connections.size >= config.limits.maxConnections) return reject(503, 'capacity');
  if (connections.countForApp(app.id) >= app.maxConnections) return reject(503, 'capacity');
  if (connections.countForIp(ip) >= config.limits.maxConnectionsPerIp) return reject(429, 'too_many_connections');

  return { ok: true, app, ip, origin };
}

export function rejectUpgrade(socket, status, code) {
  if (!socket.writable) {
    socket.destroy();
    return;
  }
  const body = JSON.stringify({ ok: false, error: { code } });
  socket.once('finish', () => socket.destroy());
  socket.end(
    `HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\n` +
      'Connection: close\r\n' +
      'Content-Type: application/json\r\n' +
      `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  );
}
