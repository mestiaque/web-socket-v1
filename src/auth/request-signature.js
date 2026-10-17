import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { DsError, ErrorCode } from '../utils/errors.js';

/**
 * HMAC-SHA256 request signing for the server-to-server HTTP API.
 *
 * Canonical string (fields joined with "\n", no trailing newline):
 *   DS1-HMAC-SHA256
 *   <HTTP method, uppercase>
 *   <request path including query string, exactly as sent>
 *   <app id>
 *   <key id>
 *   <timestamp: unix seconds>
 *   <nonce>
 *   <lowercase hex SHA-256 of the exact request body bytes>
 *
 * Headers: X-DS-App, X-DS-Key, X-DS-Timestamp, X-DS-Nonce,
 *          X-DS-Signature (lowercase hex HMAC-SHA256 of the canonical string).
 */
export const SIGNATURE_SCHEME = 'DS1-HMAC-SHA256';
export const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;
const HEX64 = /^[0-9a-f]{64}$/;

export function sha256Hex(body) {
  return createHash('sha256').update(body).digest('hex');
}

export function canonicalString({ method, path, appId, keyId, timestamp, nonce, bodyHash }) {
  return [SIGNATURE_SCHEME, method.toUpperCase(), path, appId, keyId, String(timestamp), nonce, bodyHash].join('\n');
}

/**
 * Produces signing headers for a request. Used by tests, CLI tooling and the
 * load-test script; the PHP equivalent lives in examples/laravel.
 */
export function signRequest({ method, path, body, appId, keyId, secret, now, nonce }) {
  const timestamp = Math.floor((now ?? Date.now()) / 1000);
  const n = nonce ?? randomBytes(18).toString('base64url');
  const signature = createHmac('sha256', secret)
    .update(canonicalString({ method, path, appId, keyId, timestamp, nonce: n, bodyHash: sha256Hex(body) }))
    .digest('hex');
  return {
    'X-DS-App': appId,
    'X-DS-Key': keyId,
    'X-DS-Timestamp': String(timestamp),
    'X-DS-Nonce': n,
    'X-DS-Signature': signature,
  };
}

const unauthorized = () => new DsError(ErrorCode.INVALID_SIGNATURE, 'Invalid request signature', { status: 401 });

/**
 * Verifies a signed request. Replay (nonce) checking is performed by the
 * caller after this succeeds, so unauthenticated traffic cannot fill the
 * nonce store.
 *
 * @returns {{ app: object, appId: string, keyId: string, timestamp: number, nonce: string }}
 */
export function verifyRequestSignature({ method, path, headers, body, registry, toleranceSeconds, now }) {
  const appId = headers['x-ds-app'];
  const keyId = headers['x-ds-key'];
  const tsRaw = headers['x-ds-timestamp'];
  const nonce = headers['x-ds-nonce'];
  const signature = headers['x-ds-signature'];

  if ([appId, keyId, tsRaw, nonce, signature].some((v) => typeof v !== 'string')) throw unauthorized();
  if (!/^\d{1,12}$/.test(tsRaw) || !NONCE_PATTERN.test(nonce) || !HEX64.test(signature)) throw unauthorized();

  const app = registry.get(appId);
  const secret = registry.getSecret(appId, keyId);
  if (!app || !secret) throw unauthorized();

  const timestamp = Number(tsRaw);
  const expected = createHmac('sha256', secret)
    .update(canonicalString({ method, path, appId, keyId, timestamp, nonce, bodyHash: sha256Hex(body) }))
    .digest();
  const provided = Buffer.from(signature, 'hex');
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) throw unauthorized();

  const nowSec = Math.floor((now ?? Date.now()) / 1000);
  if (Math.abs(nowSec - timestamp) > toleranceSeconds) {
    throw new DsError(ErrorCode.STALE_REQUEST, 'Request timestamp outside the accepted window', { status: 401 });
  }
  return { app, appId, keyId, timestamp, nonce };
}
