import { verifyRequestSignature } from '../auth/request-signature.js';
import { readBody } from '../security/payload-limits.js';
import { ReplayResult } from '../security/replay-protection.js';
import { DsError, ErrorCode } from '../utils/errors.js';
import { clientIp } from '../utils/client-ip.js';

/**
 * Authenticates a signed server-to-server request and returns its parsed
 * JSON body. Steps, in order:
 *
 *  1. Refuse IPs that recently produced too many invalid signatures.
 *  2. Require Content-Type: application/json.
 *  3. Read the raw body with a size limit (signature covers exact bytes).
 *  4. Verify app, key, HMAC signature and timestamp window.
 *  5. Record the nonce; reject replays. (Only after a valid signature, so
 *     unauthenticated traffic cannot fill the nonce store.)
 *  6. Apply the application's publish rate limit.
 *  7. Parse JSON.
 *
 * @returns {Promise<{ app: object, body: unknown }>}
 */
export async function authenticateSignedRequest(req, ctx) {
  const { config } = ctx;
  const ip = clientIp(req, config.trustedProxies);

  if (!ctx.signatureFailureLimiter.peek(ip)) {
    throw new DsError(ErrorCode.RATE_LIMITED, 'Too many invalid requests', { status: 429, details: { retryAfterSeconds: 60 } });
  }

  const contentType = (req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (contentType !== 'application/json') {
    throw new DsError(ErrorCode.UNSUPPORTED_MEDIA_TYPE, 'Content-Type must be application/json', { status: 415 });
  }

  const raw = await readBody(req, config.limits.maxPublishBodyBytes);

  let verified;
  try {
    verified = verifyRequestSignature({
      method: req.method,
      path: req.url,
      headers: req.headers,
      body: raw,
      registry: ctx.registry,
      toleranceSeconds: config.signatures.toleranceSeconds,
    });
  } catch (err) {
    ctx.signatureFailureLimiter.take(ip);
    ctx.metrics.inc('ds_http_auth_failures_total', { reason: err.code ?? 'unknown' });
    ctx.logger.info('signed request rejected', { ip, reason: err.code, path: req.url?.slice(0, 200) });
    throw err;
  }

  const { app, nonce, timestamp } = verified;
  const nonceExpiresAt = (timestamp + config.signatures.toleranceSeconds) * 1000 + 1000;
  const replay = ctx.nonceStore.checkAndAdd(`${app.id}\u0000${nonce}`, nonceExpiresAt);
  if (replay === ReplayResult.REPLAYED) {
    ctx.metrics.inc('ds_http_replays_rejected_total', { app: app.id });
    throw new DsError(ErrorCode.REPLAYED_REQUEST, 'Nonce has already been used', { status: 409 });
  }
  if (replay === ReplayResult.CAPACITY) {
    ctx.logger.warn('nonce store full; refusing signed requests', { size: ctx.nonceStore.size });
    throw new DsError(ErrorCode.CAPACITY, 'Server is busy; retry later', { status: 503, details: { retryAfterSeconds: 5 } });
  }

  if (!ctx.publishLimiter.take(app.id, 1, Date.now(), app.publishRate)) {
    ctx.metrics.inc('ds_publish_rate_limited_total', { app: app.id });
    const retryAfterSeconds = Math.max(1, Math.ceil(ctx.publishLimiter.retryAfterMs(app.id) / 1000));
    throw new DsError(ErrorCode.RATE_LIMITED, 'Publish rate limit exceeded', { status: 429, details: { retryAfterSeconds } });
  }

  let body;
  try {
    body = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new DsError(ErrorCode.BAD_JSON, 'Body is not valid JSON', { status: 400 });
  }
  return { app, body };
}
