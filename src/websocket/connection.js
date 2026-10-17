import WebSocket from 'ws';
import { verifyClientToken } from '../auth/client-token.js';
import { ReplayResult } from '../security/replay-protection.js';
import { TokenBucket } from '../security/rate-limiter.js';
import { parseClientMessage, serializeControl } from '../messaging/serializer.js';
import { DsError, ErrorCode } from '../utils/errors.js';
import { connectionId } from '../utils/ids.js';
import { ClientMessageType, CloseCode, ServerMessageType, readRef } from './protocol.js';

/**
 * One client WebSocket connection and its lifecycle:
 *
 *   pending --(valid auth)--> authenticated --(close)--> closed
 *      \--(timeout / bad token / rate limit)--> closed
 *
 * Only `auth` and `ping` are accepted while pending.
 */
export class ClientConnection {
  /**
   * @param {WebSocket} ws
   * @param {{ app: object, ip: string, origin: string|undefined }} info
   * @param {object} ctx shared server context (see dynamicsocket.js)
   */
  constructor(ws, { app, ip, origin }, ctx) {
    this.id = connectionId();
    this.ws = ws;
    this.app = app;
    this.appId = app.id;
    this.ip = ip;
    this.origin = origin;
    this.ctx = ctx;
    this.state = 'pending';
    this.sub = null;
    this.claims = null;
    this.userInfo = null;
    this.channels = new Set();
    this.isAlive = true;
    this.connectedAt = Date.now();
    this.rateViolations = 0;
    this.bucket = new TokenBucket({
      perSecond: ctx.config.rateLimits.clientMessagesPerSecond,
      burst: ctx.config.rateLimits.clientMessagesBurst,
    });
    this.timers = new Set();
    this.log = ctx.logger.child({ connectionId: this.id, appId: this.appId });
  }

  start() {
    const { ws, ctx } = this;
    ctx.connections.add(this);
    ctx.metrics.inc('ds_connections_opened_total', { app: this.appId });

    ws.on('message', (data, isBinary) => this.onMessage(data, isBinary));
    ws.on('pong', () => {
      this.isAlive = true;
    });
    ws.on('close', (code) => this.onClose(code));
    ws.on('error', (err) => {
      // Protocol violations (invalid frames, oversize payloads) are detected
      // by `ws`, which then closes the socket; we only record them.
      ctx.metrics.inc('ds_socket_errors_total', { code: err.code ?? 'unknown' });
      this.log.debug('socket error', { code: err.code, message: err.message });
    });

    this.setTimer(() => {
      if (this.state === 'pending') {
        ctx.metrics.inc('ds_auth_failures_total', { reason: 'timeout' });
        this.sendError(ErrorCode.AUTH_TIMEOUT, 'Authentication timed out');
        this.close(CloseCode.AUTH_TIMEOUT, 'auth_timeout');
      }
    }, ctx.config.timeouts.authTimeoutMs);

    this.send({ type: ServerMessageType.HELLO, connectionId: this.id, authTimeoutMs: ctx.config.timeouts.authTimeoutMs });
    this.log.debug('connection opened', { ip: this.ip });
  }

  isOpen() {
    return this.state === 'authenticated' && this.ws.readyState === WebSocket.OPEN;
  }

  setTimer(fn, ms) {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      fn();
    }, ms);
    timer.unref?.();
    this.timers.add(timer);
    return timer;
  }

  send(message) {
    if (this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(serializeControl(message));
  }

  sendError(code, message, extra = {}) {
    this.send({ type: ServerMessageType.ERROR, code, message, ...extra });
  }

  close(code, reason) {
    if (this.state === 'closed') return;
    if (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING) {
      this.ws.close(code, reason);
    }
  }

  /** Closes a connection whose outbound buffer is over the limit. */
  closeSlowConsumer() {
    if (this.slowConsumerClosing) return;
    this.slowConsumerClosing = true;
    this.state = 'closing';
    this.ctx.metrics.inc('ds_slow_consumer_disconnects_total', { app: this.appId });
    this.log.warn('closing slow consumer', { bufferedAmount: this.ws.bufferedAmount });
    this.ws.close(CloseCode.SLOW_CONSUMER, 'slow_consumer');
    // The close frame itself sits behind the full buffer; do not wait forever.
    this.setTimer(() => this.ws.terminate(), this.ctx.config.timeouts.slowConsumerGraceMs);
  }

  onMessage(data, isBinary) {
    if (this.state === 'closed' || this.state === 'closing') return;
    this.isAlive = true;

    if (!this.bucket.take()) {
      this.rateViolations += 1;
      this.ctx.metrics.inc('ds_client_rate_limited_total', { app: this.appId });
      if (this.rateViolations >= this.ctx.config.rateLimits.clientViolationsBeforeClose) {
        this.sendError(ErrorCode.RATE_LIMITED, 'Too many messages');
        this.close(CloseCode.RATE_LIMITED, 'rate_limited');
      } else {
        this.sendError(ErrorCode.RATE_LIMITED, 'Too many messages; slow down');
      }
      return;
    }

    let msg;
    try {
      msg = parseClientMessage(data, isBinary);
    } catch (err) {
      this.sendError(err.code ?? ErrorCode.BAD_MESSAGE, err.message);
      return;
    }
    const ref = readRef(msg);
    try {
      switch (msg.type) {
        case ClientMessageType.AUTH:
          this.handleAuth(msg, ref);
          break;
        case ClientMessageType.SUBSCRIBE:
          this.handleSubscribe(msg, ref);
          break;
        case ClientMessageType.UNSUBSCRIBE:
          this.handleUnsubscribe(msg, ref);
          break;
        case ClientMessageType.PING:
          this.send({ type: ServerMessageType.PONG, ref });
          break;
        default:
          this.sendError(ErrorCode.UNKNOWN_TYPE, 'Unknown message type', { ref });
      }
    } catch (err) {
      if (err instanceof DsError) {
        this.sendError(err.code, err.message, { ref, channel: typeof msg.channel === 'string' ? msg.channel.slice(0, 128) : undefined });
      } else {
        this.log.error('unexpected error handling message', { err });
        this.sendError(ErrorCode.INTERNAL, 'Internal error', { ref });
      }
    }
  }

  handleAuth(msg, ref) {
    const { ctx } = this;
    if (this.state === 'authenticated') {
      throw new DsError(ErrorCode.ALREADY_AUTHENTICATED, 'Connection is already authenticated');
    }
    if (!ctx.authFailureLimiter.peek(this.ip)) {
      ctx.metrics.inc('ds_auth_failures_total', { reason: 'ip_rate_limited' });
      this.sendError(ErrorCode.RATE_LIMITED, 'Too many failed authentication attempts', { ref });
      this.close(CloseCode.RATE_LIMITED, 'rate_limited');
      return;
    }

    const { config } = ctx;
    let claims;
    try {
      claims = verifyClientToken(msg.token, {
        registry: ctx.registry,
        expectedAppId: this.appId,
        maxTtlSeconds: config.tokens.maxTtlSeconds,
        clockSkewSeconds: config.tokens.clockSkewSeconds,
      });
      if (config.tokens.singleUse) {
        const expiresAt = (claims.exp + config.tokens.clockSkewSeconds) * 1000;
        const result = ctx.jtiStore.checkAndAdd(`${this.appId}\u0000${claims.jti}`, expiresAt);
        if (result === ReplayResult.REPLAYED) throw new DsError(ErrorCode.TOKEN_REUSED, 'Token has already been used');
        if (result === ReplayResult.CAPACITY) throw new DsError(ErrorCode.CAPACITY, 'Server is busy; retry later');
      }
    } catch (err) {
      const code = err instanceof DsError ? err.code : ErrorCode.AUTH_FAILED;
      if (code !== ErrorCode.CAPACITY) ctx.authFailureLimiter.take(this.ip);
      ctx.metrics.inc('ds_auth_failures_total', { reason: code });
      this.log.info('authentication failed', { ip: this.ip, reason: code });
      this.sendError(code, err instanceof DsError ? err.message : 'Authentication failed', { ref });
      this.close(CloseCode.AUTH_FAILED, code);
      return;
    }

    this.state = 'authenticated';
    this.claims = claims;
    this.sub = claims.sub;
    this.userInfo = claims.user;
    ctx.channels.registerUser(this);
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();

    let sessionExpiresAt = null;
    if (config.tokens.maxSessionSeconds > 0) {
      const ms = config.tokens.maxSessionSeconds * 1000;
      sessionExpiresAt = new Date(Date.now() + ms).toISOString();
      this.setTimer(() => {
        this.sendError(ErrorCode.TOKEN_EXPIRED, 'Session expired; reconnect with a new token');
        this.close(CloseCode.SESSION_EXPIRED, 'session_expired');
      }, ms);
    }

    ctx.metrics.inc('ds_auth_success_total', { app: this.appId });
    this.log.debug('authenticated', { sub: this.sub });
    this.send({ type: ServerMessageType.AUTH_OK, ref, connectionId: this.id, appId: this.appId, sub: this.sub, sessionExpiresAt });
  }

  handleSubscribe(msg, ref) {
    if (this.state !== 'authenticated') throw new DsError(ErrorCode.NOT_AUTHENTICATED, 'Authenticate first');
    const { channel } = msg;
    let result;
    try {
      result = this.ctx.channels.subscribe(this, channel);
    } catch (err) {
      if (err.code === ErrorCode.FORBIDDEN) this.ctx.metrics.inc('ds_subscriptions_denied_total', { app: this.appId });
      throw err;
    }
    this.send({ type: ServerMessageType.SUBSCRIBED, channel, ref, ...(result.presence && { presence: result.presence }) });
  }

  handleUnsubscribe(msg, ref) {
    if (this.state !== 'authenticated') throw new DsError(ErrorCode.NOT_AUTHENTICATED, 'Authenticate first');
    const { channel } = msg;
    this.ctx.channels.unsubscribe(this, channel);
    this.send({ type: ServerMessageType.UNSUBSCRIBED, channel, ref });
  }

  onClose(code) {
    if (this.state === 'closed') return;
    this.state = 'closed';
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
    this.ctx.channels.removeConnection(this);
    this.ctx.connections.remove(this);
    this.ctx.metrics.inc('ds_connections_closed_total', { app: this.appId, code: String(code) });
    this.log.debug('connection closed', { code });
    this.ctx.onConnectionClosed?.(this);
  }
}
