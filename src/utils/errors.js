/**
 * Error codes are part of the public protocol (see docs/API.md).
 * Messages attached to DsError are safe to show to untrusted clients;
 * never put secrets, tokens, or internal details into them.
 */
export const ErrorCode = Object.freeze({
  BAD_JSON: 'bad_json',
  BAD_MESSAGE: 'bad_message',
  UNKNOWN_TYPE: 'unknown_type',
  NOT_AUTHENTICATED: 'not_authenticated',
  ALREADY_AUTHENTICATED: 'already_authenticated',
  AUTH_FAILED: 'auth_failed',
  AUTH_TIMEOUT: 'auth_timeout',
  TOKEN_EXPIRED: 'token_expired',
  TOKEN_REUSED: 'token_reused',
  FORBIDDEN: 'forbidden',
  INVALID_CHANNEL: 'invalid_channel',
  INVALID_EVENT: 'invalid_event',
  SUBSCRIPTION_LIMIT: 'subscription_limit',
  PRESENCE_FULL: 'presence_full',
  RATE_LIMITED: 'rate_limited',
  PAYLOAD_TOO_LARGE: 'payload_too_large',
  UNSUPPORTED_MEDIA_TYPE: 'unsupported_media_type',
  INVALID_SIGNATURE: 'invalid_signature',
  STALE_REQUEST: 'stale_request',
  REPLAYED_REQUEST: 'replayed_request',
  NOT_FOUND: 'not_found',
  METHOD_NOT_ALLOWED: 'method_not_allowed',
  CAPACITY: 'capacity_exceeded',
  UNAVAILABLE: 'unavailable',
  INTERNAL: 'internal_error',
});

export class DsError extends Error {
  /**
   * @param {string} code one of ErrorCode
   * @param {string} message client-safe message
   * @param {{status?: number, details?: object}} [opts]
   */
  constructor(code, message, opts = {}) {
    super(message);
    this.name = 'DsError';
    this.code = code;
    this.status = opts.status ?? 400;
    this.details = opts.details;
  }
}

export class ConfigError extends Error {
  /** @param {string[]} problems */
  constructor(problems) {
    super(`Invalid configuration:\n - ${problems.join('\n - ')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}
