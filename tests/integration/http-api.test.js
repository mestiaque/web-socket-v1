import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SECRETS, startServer } from '../helpers/harness.js';

test('HTTP API', async (t) => {
  const h = await startServer({ DS_METRICS_TOKEN: 'metrics-token-0123456789', DS_MAX_PUBLISH_BODY_BYTES: '2048' });
  t.after(() => h.stop());

  await t.test('health and readiness', async () => {
    const health = await fetch(`${h.base}/healthz`);
    assert.equal(health.status, 200);
    const body = await health.json();
    assert.equal(body.status, 'ok');
    assert.match(body.instanceId, /^[0-9a-f]{12}$/);
    assert.equal(health.headers.get('x-content-type-options'), 'nosniff');
    const ready = await fetch(`${h.base}/readyz`);
    assert.equal((await ready.json()).status, 'ready');
  });

  await t.test('unknown routes and methods', async () => {
    assert.equal((await fetch(`${h.base}/nope`)).status, 404);
    assert.equal((await fetch(`${h.base}/__proto__`)).status, 404);
    const res = await fetch(`${h.base}/v1/publish`);
    assert.equal(res.status, 405);
    assert.equal(res.headers.get('allow'), 'POST');
  });

  await t.test('metrics require the bearer token', async () => {
    assert.equal((await fetch(`${h.base}/metrics`)).status, 401);
    assert.equal((await fetch(`${h.base}/metrics`, { headers: { Authorization: 'Bearer wrong' } })).status, 401);
    const res = await fetch(`${h.base}/metrics`, { headers: { Authorization: 'Bearer metrics-token-0123456789' } });
    assert.equal(res.status, 200);
    assert.match(await res.text(), /# TYPE ds_connections gauge/);
  });

  await t.test('publish succeeds with a valid signature and reports delivery', async () => {
    const res = await h.publish({ channel: 'orders', event: 'order.created', data: { id: 1 }, id: 'order-1-created' });
    assert.equal(res.status, 200);
    assert.equal(res.body.ok, true);
    assert.equal(res.body.id, 'order-1-created');
    assert.deepEqual(res.body.delivery, { scope: 'local', recipients: 0, sent: 0, dropped: 0 });
  });

  await t.test('publish with a rotated (second) key works', async () => {
    assert.equal((await h.publish({ channel: 'orders', event: 'e' }, { key: 'k2' })).status, 200);
  });

  await t.test('rejects unsigned and badly signed requests', async () => {
    const unsigned = await fetch(`${h.base}/v1/publish`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(unsigned.status, 401);
    assert.equal((await unsigned.json()).error.code, 'invalid_signature');
    assert.equal((await h.publish({ channel: 'orders', event: 'e' }, { secret: 'w'.repeat(40) })).status, 401);
    assert.equal((await h.publish({ channel: 'orders', event: 'e' }, { app: 'ghost', key: 'k1' })).status, 401);
    // Signature computed for one body, different body sent:
    const res = await h.publish({ channel: 'orders', event: 'e' }, { headers: {} });
    const replayWithOtherBody = await fetch(`${h.base}/v1/publish`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...res.sig, 'X-DS-Nonce': 'n'.repeat(24) },
      body: JSON.stringify({ channel: 'admin', event: 'e' }),
    });
    assert.equal(replayWithOtherBody.status, 401);
  });

  await t.test('rejects replayed nonces with 409', async () => {
    const nonce = 'replay-nonce-0123456789';
    assert.equal((await h.publish({ channel: 'orders', event: 'e' }, { nonce })).status, 200);
    const replay = await h.publish({ channel: 'orders', event: 'e' }, { nonce });
    assert.equal(replay.status, 409);
    assert.equal(replay.body.error.code, 'replayed_request');
    // Same nonce for a different app is independent.
    assert.equal((await h.publish({ channel: 'orders', event: 'e' }, { app: 'parking', nonce })).status, 200);
  });

  await t.test('rejects stale and future timestamps', async () => {
    const stale = await h.publish({ channel: 'orders', event: 'e' }, { now: Date.now() - 10 * 60_000 });
    assert.equal(stale.status, 401);
    assert.equal(stale.body.error.code, 'stale_request');
    assert.equal((await h.publish({ channel: 'orders', event: 'e' }, { now: Date.now() + 10 * 60_000 })).status, 401);
  });

  await t.test('enforces content type and body size', async () => {
    const res = await h.publish({ channel: 'orders', event: 'e' }, { headers: { 'Content-Type': 'text/plain' } });
    assert.equal(res.status, 415);
    const big = await h.publish({ channel: 'orders', event: 'e', data: 'x'.repeat(4096) });
    assert.equal(big.status, 413);
    assert.equal(big.body.error.code, 'payload_too_large');
  });

  await t.test('validates JSON, channels and events (after authentication)', async () => {
    const badJson = await h.publish('{"channel":');
    assert.equal(badJson.status, 400);
    assert.equal(badJson.body.error.code, 'bad_json');
    assert.equal((await h.publish({ channel: 'no spaces allowed', event: 'e' })).body.error.code, 'invalid_channel');
    assert.equal((await h.publish({ channel: 'orders', event: '<script>' })).body.error.code, 'invalid_event');
    assert.equal((await h.publish({ event: 'e' })).status, 422);
  });

  await t.test('error responses never include stack traces or secrets', async () => {
    const res = await h.publish('{"channel":');
    assert.ok(!/at .*\.js:\d+/.test(res.text));
    assert.ok(!res.text.includes(SECRETS.shop.k1));
  });
});

test('per-application publish rate limit returns 429 with Retry-After', async (t) => {
  const h = await startServer({ DS_PUBLISH_RATE_PER_SEC: '1', DS_PUBLISH_RATE_BURST: '3' });
  t.after(() => h.stop());
  const statuses = [];
  for (let i = 0; i < 5; i++) statuses.push((await h.publish({ channel: 'orders', event: 'e' })).status);
  assert.deepEqual(statuses, [200, 200, 200, 429, 429]);
  const limited = await h.publish({ channel: 'orders', event: 'e' });
  assert.ok(Number(limited.headers.get('retry-after')) >= 1);
  // Another app has its own bucket.
  assert.equal((await h.publish({ channel: 'orders', event: 'e' }, { app: 'parking' })).status, 200);
});

test('repeated invalid signatures from one IP are throttled', async (t) => {
  const h = await startServer({ DS_AUTH_FAILURES_PER_IP_PER_MIN: '3' });
  t.after(() => h.stop());
  const statuses = [];
  for (let i = 0; i < 5; i++) statuses.push((await h.publish({ channel: 'orders', event: 'e' }, { secret: 'w'.repeat(40) })).status);
  assert.deepEqual(statuses, [401, 401, 401, 429, 429]);
  // Even a valid request is refused while the IP is throttled.
  assert.equal((await h.publish({ channel: 'orders', event: 'e' })).status, 429);
});

test('/v1/disconnect validates all user ids before closing anything', async (t) => {
  const h = await startServer();
  t.after(() => h.stop());
  const c = await h.authed({ sub: 'keep' });
  const res = await h.signed('/v1/disconnect', { users: ['keep', ''] });
  assert.equal(res.status, 422);
  c.send({ type: 'ping' });
  await c.next((m) => m.type === 'pong');
  assert.equal((await h.signed('/v1/disconnect', { users: [] })).status, 422);
  await c.close();
});
