/**
 * Wire protocol constants (documented in docs/API.md).
 *
 * Client -> server messages are control messages only. Clients cannot
 * publish application events; publishing happens through the signed HTTP API.
 */
export const ClientMessageType = Object.freeze({
  AUTH: 'auth',
  SUBSCRIBE: 'subscribe',
  UNSUBSCRIBE: 'unsubscribe',
  PING: 'ping',
});

export const ServerMessageType = Object.freeze({
  HELLO: 'hello',
  AUTH_OK: 'auth_ok',
  SUBSCRIBED: 'subscribed',
  UNSUBSCRIBED: 'unsubscribed',
  PONG: 'pong',
  ERROR: 'error',
  EVENT: 'event',
  PRESENCE: 'presence',
});

export const CloseCode = Object.freeze({
  NORMAL: 1000,
  GOING_AWAY: 1001, // server shutting down
  SESSION_EXPIRED: 4000, // reconnect with a fresh token
  AUTH_FAILED: 4001, // invalid / expired / reused token
  AUTH_TIMEOUT: 4002, // no valid auth message in time
  SLOW_CONSUMER: 4009, // outbound buffer limit exceeded
  DISCONNECTED: 4010, // terminated by the application backend (e.g. logout)
  RATE_LIMITED: 4029, // repeated inbound rate-limit violations
});

/** Optional client correlation id echoed back in replies. */
export function readRef(msg) {
  const { ref } = msg;
  if (typeof ref === 'string' && ref.length > 0 && ref.length <= 64) return ref;
  if (Number.isSafeInteger(ref)) return ref;
  return undefined;
}
