import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { DsError, ErrorCode } from '../utils/errors.js';
import { isValidChannelPattern } from '../channels/channel-names.js';

/**
 * Short-lived client tokens use the JWT compact format with HS256 only:
 *   base64url(header) "." base64url(claims) "." base64url(HMAC-SHA256(secret, header "." claims))
 *
 * header: { "alg": "HS256", "typ": "JWT", "kid": "<key id>" }
 * claims: { appId, sub, iat, exp, jti, channels: string[], user?: object }
 *
 * `user` is optional public profile data (e.g. { name, avatar }) that is shown
 * to other members of presence channels. Max 1 KiB of JSON.
 *
 * Any other "alg" (including "none") is rejected, so algorithm-confusion
 * attacks do not apply. Tokens are issued by the application backend
 * (e.g. Laravel) and must never be minted in browser code.
 */
export const MAX_TOKEN_LENGTH = 8192;
export const MAX_TOKEN_CHANNELS = 100;
export const MAX_USER_INFO_BYTES = 1024;
const SEGMENT = /^[A-Za-z0-9_-]+$/;
const JTI_PATTERN = /^[A-Za-z0-9_.:-]{8,128}$/;

function b64urlJson(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

function sign(secret, data) {
  return createHmac('sha256', secret).update(data).digest();
}

/**
 * Creates a client token. Intended for backends, tests and tooling.
 * @param {{appId: string, sub: string, channels?: string[], ttlSeconds?: number, keyId: string,
 *          secret: string|Buffer, now?: number, jti?: string, extra?: object}} params
 */
export function createClientToken({ appId, sub, channels = [], ttlSeconds = 300, keyId, secret, now, jti, user, extra = {} }) {
  const iat = Math.floor((now ?? Date.now()) / 1000);
  const header = { alg: 'HS256', typ: 'JWT', kid: keyId };
  const claims = {
    ...extra,
    appId,
    sub,
    iat,
    exp: iat + ttlSeconds,
    jti: jti ?? randomBytes(16).toString('base64url'),
    channels,
    ...(user !== undefined && { user }),
  };
  const signingInput = `${b64urlJson(header)}.${b64urlJson(claims)}`;
  return `${signingInput}.${sign(secret, signingInput).toString('base64url')}`;
}

function decodeSegment(segment) {
  if (!SEGMENT.test(segment)) return undefined;
  try {
    const value = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

const invalid = () => new DsError(ErrorCode.AUTH_FAILED, 'Authentication failed', { status: 401 });

/**
 * Verifies signature and claims. Throws DsError on any failure. Failure
 * messages are deliberately generic, except for expiry, which clients need in
 * order to refresh their token.
 *
 * @param {string} token
 * @param {{ registry: import('./app-registry.js').AppRegistry, expectedAppId: string,
 *           maxTtlSeconds: number, clockSkewSeconds: number, now?: number }} opts
 * @returns {{ appId: string, sub: string, iat: number, exp: number, jti: string, channels: string[], user: object|null, kid: string }}
 */
export function verifyClientToken(token, opts) {
  const { registry, expectedAppId, maxTtlSeconds, clockSkewSeconds } = opts;
  const nowSec = Math.floor((opts.now ?? Date.now()) / 1000);

  if (typeof token !== 'string' || token.length === 0 || token.length > MAX_TOKEN_LENGTH) throw invalid();
  const parts = token.split('.');
  if (parts.length !== 3) throw invalid();
  const [h, p, s] = parts;

  const header = decodeSegment(h);
  if (!header || header.alg !== 'HS256' || (header.typ !== undefined && header.typ !== 'JWT') || typeof header.kid !== 'string') {
    throw invalid();
  }
  // Claims are parsed before signature verification only to locate the key.
  const claims = decodeSegment(p);
  if (!claims || typeof claims.appId !== 'string' || claims.appId !== expectedAppId) throw invalid();

  const secret = registry.getSecret(claims.appId, header.kid);
  if (!secret || !SEGMENT.test(s)) throw invalid();
  const expected = sign(secret, `${h}.${p}`);
  const provided = Buffer.from(s, 'base64url');
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) throw invalid();

  // Signature is valid; now validate claims strictly.
  let sub = claims.sub;
  if (Number.isSafeInteger(sub) && sub >= 0) sub = String(sub);
  if (typeof sub !== 'string' || sub.length === 0 || sub.length > 191) throw invalid();
  const { iat, exp, jti, channels } = claims;
  if (!Number.isSafeInteger(iat) || !Number.isSafeInteger(exp) || exp <= iat) throw invalid();
  if (exp - iat > maxTtlSeconds) throw invalid();
  if (iat > nowSec + clockSkewSeconds) throw invalid();
  if (nowSec > exp + clockSkewSeconds) {
    throw new DsError(ErrorCode.TOKEN_EXPIRED, 'Token expired', { status: 401 });
  }
  if (typeof jti !== 'string' || !JTI_PATTERN.test(jti)) throw invalid();
  if (!Array.isArray(channels) || channels.length > MAX_TOKEN_CHANNELS || !channels.every(isValidChannelPattern)) {
    throw invalid();
  }
  const { user } = claims;
  if (user !== undefined && (typeof user !== 'object' || user === null || Array.isArray(user) || Buffer.byteLength(JSON.stringify(user)) > MAX_USER_INFO_BYTES)) {
    throw invalid();
  }

  return { appId: claims.appId, sub, iat, exp, jti, channels: [...channels], user: user ?? null, kid: header.kid };
}
