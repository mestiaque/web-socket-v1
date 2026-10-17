import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ExpiringKeyStore, ReplayResult } from '../../src/security/replay-protection.js';
import { KeyedRateLimiter, TokenBucket, perMinute } from '../../src/security/rate-limiter.js';
import { checkOrigin } from '../../src/auth/origin-policy.js';
import { clientIp } from '../../src/utils/client-ip.js';

test('replay store accepts once, rejects repeats until expiry', () => {
  const store = new ExpiringKeyStore({ maxEntries: 10 });
  assert.equal(store.checkAndAdd('n1', 1000, 0), ReplayResult.ACCEPTED);
  assert.equal(store.checkAndAdd('n1', 1000, 500), ReplayResult.REPLAYED);
  assert.equal(store.checkAndAdd('n1', 3000, 1000), ReplayResult.ACCEPTED);
});

test('replay store fails closed when full of live entries and recovers after sweep', () => {
  const store = new ExpiringKeyStore({ maxEntries: 3, minSweepIntervalMs: 0 });
  for (const k of ['a', 'b', 'c']) assert.equal(store.checkAndAdd(k, 1000, 0), ReplayResult.ACCEPTED);
  assert.equal(store.checkAndAdd('d', 1000, 10), ReplayResult.CAPACITY);
  assert.equal(store.checkAndAdd('a', 1000, 10), ReplayResult.REPLAYED, 'existing entries are never evicted');
  assert.equal(store.checkAndAdd('d', 2000, 1000), ReplayResult.ACCEPTED, 'expired entries are swept');
  assert.equal(store.size, 1);
});

test('token bucket enforces burst and refill', () => {
  const b = new TokenBucket({ perSecond: 2, burst: 3 }, 0);
  assert.deepEqual([b.take(1, 0), b.take(1, 0), b.take(1, 0), b.take(1, 0)], [true, true, true, false]);
  assert.equal(b.retryAfterMs(), 500);
  assert.equal(b.take(1, 500), true);
  assert.equal(b.take(1, 500), false);
});

test('keyed limiter isolates keys, peeks without consuming, and bounds memory', () => {
  const l = new KeyedRateLimiter({ perSecond: 1, burst: 1, maxKeys: 2 });
  assert.equal(l.take('a', 1, 0), true);
  assert.equal(l.peek('a', 1, 0), false);
  assert.equal(l.take('a', 1, 0), false);
  assert.equal(l.take('b', 1, 0), true);
  assert.equal(l.take('c', 1, 0), true);
  assert.equal(l.size, 2);
  l.sweep(10_000);
  assert.equal(l.size, 0);
  assert.deepEqual(perMinute(60), { perSecond: 1, burst: 60 });
});

test('origin policy', () => {
  const app = { allowedOrigins: ['https://shop.test'], allowMissingOrigin: false };
  assert.equal(checkOrigin(app, 'https://shop.test').ok, true);
  assert.equal(checkOrigin(app, 'https://evil.test').reason, 'origin_not_allowed');
  assert.equal(checkOrigin(app, 'https://shop.test.evil.test').ok, false);
  assert.equal(checkOrigin(app, 'http://shop.test').ok, false);
  assert.equal(checkOrigin(app, 'null').ok, false);
  assert.equal(checkOrigin(app, 'https://shop.test/').ok, false);
  assert.equal(checkOrigin(app, undefined).reason, 'origin_missing');
  assert.equal(checkOrigin({ ...app, allowMissingOrigin: true }, undefined).ok, true);
  assert.equal(checkOrigin({ ...app, allowedOrigins: ['*'] }, 'https://any.test').ok, true);
});

test('client IP ignores X-Forwarded-For unless the peer is a trusted proxy', () => {
  const req = (remote, xff) => ({ socket: { remoteAddress: remote }, headers: xff ? { 'x-forwarded-for': xff } : {} });
  assert.equal(clientIp(req('203.0.113.9', '1.2.3.4'), []), '203.0.113.9');
  assert.equal(clientIp(req('203.0.113.9', '1.2.3.4'), ['10.0.0.1']), '203.0.113.9');
  assert.equal(clientIp(req('::ffff:10.0.0.1', '1.2.3.4'), ['10.0.0.1']), '1.2.3.4');
  // Spoofed left-most entry is ignored; right-most untrusted hop wins.
  assert.equal(clientIp(req('10.0.0.1', '6.6.6.6, 1.2.3.4'), ['10.0.0.1']), '1.2.3.4');
  assert.equal(clientIp(req('10.0.0.1', '1.2.3.4, 10.0.0.2'), ['10.0.0.1', '10.0.0.2']), '1.2.3.4');
  assert.equal(clientIp(req('10.0.0.1', 'garbage'), ['10.0.0.1']), '10.0.0.1');
});
