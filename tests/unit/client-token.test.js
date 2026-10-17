import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createClientToken, verifyClientToken } from '../../src/auth/client-token.js';
import { AppRegistry } from '../../src/auth/app-registry.js';
import { ErrorCode } from '../../src/utils/errors.js';

const S1 = 'x'.repeat(32);
const S2 = 'y'.repeat(32);
const registry = new AppRegistry([
  { id: 'shop', keys: [{ id: 'k1', secret: Buffer.from(S1) }, { id: 'k2', secret: Buffer.from(S2) }] },
  { id: 'other', keys: [{ id: 'k1', secret: Buffer.from('z'.repeat(32)) }] },
]);
const NOW = Date.UTC(2026, 0, 1);
const opts = { registry, expectedAppId: 'shop', maxTtlSeconds: 900, clockSkewSeconds: 30, now: NOW };
const make = (o = {}) => createClientToken({ appId: 'shop', sub: '42', channels: ['orders'], keyId: 'k1', secret: S1, now: NOW, ...o });
const code = (fn) => {
  try {
    fn();
  } catch (err) {
    return err.code;
  }
  return 'no error';
};

function forge(header, claims, secret = S1) {
  const h = Buffer.from(JSON.stringify(header)).toString('base64url');
  const p = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const s = createHmac('sha256', secret).update(`${h}.${p}`).digest('base64url');
  return `${h}.${p}.${s}`;
}
const baseClaims = () => ({ appId: 'shop', sub: '42', iat: NOW / 1000, exp: NOW / 1000 + 60, jti: 'abcdefgh1234', channels: [] });

test('round-trips a valid token', () => {
  const claims = verifyClientToken(make(), opts);
  assert.equal(claims.appId, 'shop');
  assert.equal(claims.sub, '42');
  assert.deepEqual(claims.channels, ['orders']);
  assert.equal(claims.kid, 'k1');
});

test('accepts any configured key (rotation) and integer subjects', () => {
  assert.equal(verifyClientToken(make({ keyId: 'k2', secret: S2 }), opts).kid, 'k2');
  assert.equal(verifyClientToken(make({ sub: 7 }), opts).sub, '7');
});

test('rejects expired tokens with token_expired (after skew)', () => {
  const t = make({ ttlSeconds: 60 });
  assert.doesNotThrow(() => verifyClientToken(t, { ...opts, now: NOW + 85_000 }));
  assert.equal(code(() => verifyClientToken(t, { ...opts, now: NOW + 95_000 })), ErrorCode.TOKEN_EXPIRED);
});

test('rejects invalid signatures, tampering and wrong keys', () => {
  const t = make();
  const [h, p, s] = t.split('.');
  const flipped = s[0] === 'A' ? 'B' + s.slice(1) : 'A' + s.slice(1);
  assert.equal(code(() => verifyClientToken(`${h}.${p}.${flipped}`, opts)), ErrorCode.AUTH_FAILED);
  const tampered = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(p, 'base64url')), channels: ['*'] })).toString('base64url');
  assert.equal(code(() => verifyClientToken(`${h}.${tampered}.${s}`, opts)), ErrorCode.AUTH_FAILED);
  assert.equal(code(() => verifyClientToken(make({ secret: 'w'.repeat(32) }), opts)), ErrorCode.AUTH_FAILED);
  assert.equal(code(() => verifyClientToken(make({ keyId: 'nope' }), opts)), ErrorCode.AUTH_FAILED);
});

test('rejects tokens for another or unknown application', () => {
  assert.equal(code(() => verifyClientToken(make(), { ...opts, expectedAppId: 'other' })), ErrorCode.AUTH_FAILED);
  const otherToken = createClientToken({ appId: 'other', sub: '1', keyId: 'k1', secret: 'z'.repeat(32), now: NOW });
  assert.equal(code(() => verifyClientToken(otherToken, opts)), ErrorCode.AUTH_FAILED);
  assert.equal(code(() => verifyClientToken(make({ appId: 'ghost' }), { ...opts, expectedAppId: 'ghost' })), ErrorCode.AUTH_FAILED);
});

test('rejects alg none / other algorithms and malformed tokens', () => {
  const claims = baseClaims();
  const none = `${Buffer.from(JSON.stringify({ alg: 'none', kid: 'k1' })).toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.`;
  assert.equal(code(() => verifyClientToken(none, opts)), ErrorCode.AUTH_FAILED);
  assert.equal(code(() => verifyClientToken(forge({ alg: 'HS512', kid: 'k1' }, claims), opts)), ErrorCode.AUTH_FAILED);
  for (const bad of [undefined, 42, '', 'a.b', 'a.b.c.d', '!!.??.**', 'x'.repeat(9000)]) {
    assert.equal(code(() => verifyClientToken(bad, opts)), ErrorCode.AUTH_FAILED, String(bad).slice(0, 20));
  }
});

test('rejects unreasonable lifetimes and invalid claims', () => {
  assert.equal(code(() => verifyClientToken(make({ ttlSeconds: 3600 }), opts)), ErrorCode.AUTH_FAILED);
  const h = { alg: 'HS256', typ: 'JWT', kid: 'k1' };
  const cases = {
    futureIat: { iat: NOW / 1000 + 120, exp: NOW / 1000 + 180 },
    expBeforeIat: { exp: NOW / 1000 - 1 },
    floatIat: { iat: NOW / 1000 + 0.5 },
    missingJti: { jti: undefined },
    shortJti: { jti: 'abc' },
    emptySub: { sub: '' },
    objectSub: { sub: { id: 1 } },
    channelsNotArray: { channels: 'orders' },
    badChannel: { channels: ['has space'] },
    tooManyChannels: { channels: Array.from({ length: 101 }, (_, i) => `c${i}`) },
  };
  for (const [name, override] of Object.entries(cases)) {
    assert.equal(code(() => verifyClientToken(forge(h, { ...baseClaims(), ...override }), opts)), ErrorCode.AUTH_FAILED, name);
  }
});

test('optional "user" claim: public profile for presence, max 1 KiB object', () => {
  assert.equal(verifyClientToken(make(), opts).user, null);
  assert.deepEqual(verifyClientToken(make({ user: { name: 'Alice', avatar: '/a.png' } }), opts).user, { name: 'Alice', avatar: '/a.png' });
  const h = { alg: 'HS256', typ: 'JWT', kid: 'k1' };
  for (const user of ['Alice', ['a'], null, { bio: 'x'.repeat(1100) }]) {
    assert.equal(code(() => verifyClientToken(forge(h, { ...baseClaims(), user }), opts)), ErrorCode.AUTH_FAILED, JSON.stringify(user)?.slice(0, 20));
  }
});
