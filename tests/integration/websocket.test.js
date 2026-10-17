import { test } from 'node:test';
import assert from 'node:assert/strict';
import { delay, startServer, waitFor } from '../helpers/harness.js';

test('WebSocket lifecycle', async (t) => {
  const h = await startServer({ DS_AUTH_TIMEOUT_MS: '300' });
  t.after(() => h.stop());

  await t.test('sends hello, authenticates a valid token', async () => {
    const c = await h.connect();
    c.send({ type: 'auth', token: h.token(), ref: 'a1' });
    const ok = await c.next((m) => m.type === 'auth_ok');
    assert.equal(ok.appId, 'shop');
    assert.equal(ok.sub, '42');
    assert.equal(ok.ref, 'a1');
    assert.ok(ok.sessionExpiresAt);
    await c.close();
  });

  await t.test('closes unauthenticated connections after the auth timeout', async () => {
    const c = await h.connect();
    const err = await c.next((m) => m.type === 'error');
    assert.equal(err.code, 'auth_timeout');
    assert.equal((await c.closed).code, 4002);
  });

  await t.test('rejects invalid, expired and reused tokens', async () => {
    const bad = await h.connect();
    bad.send({ type: 'auth', token: h.token({ secret: 'wrong-secret-wrong-secret-wrong-secret' }) });
    assert.equal((await bad.next((m) => m.type === 'error')).code, 'auth_failed');
    assert.equal((await bad.closed).code, 4001);

    const expired = await h.connect();
    expired.send({ type: 'auth', token: h.token({}, { ttlSeconds: 60, now: Date.now() - 600_000 }) });
    assert.equal((await expired.next((m) => m.type === 'error')).code, 'token_expired');
    assert.equal((await expired.closed).code, 4001);

    const token = h.token();
    const first = await h.connect();
    first.send({ type: 'auth', token });
    await first.next((m) => m.type === 'auth_ok');
    const second = await h.connect();
    second.send({ type: 'auth', token });
    assert.equal((await second.next((m) => m.type === 'error')).code, 'token_reused');
    await first.close();
  });

  await t.test('rejects malformed auth and protocol misuse', async () => {
    const c = await h.connect();
    c.send('{not json');
    assert.equal((await c.next((m) => m.type === 'error')).code, 'bad_json');
    c.send({ type: 'subscribe', channel: 'orders', ref: 7 });
    const e = await c.next((m) => m.type === 'error');
    assert.equal(e.code, 'not_authenticated');
    assert.equal(e.ref, 7);
    c.send({ type: 'whatever' });
    assert.equal((await c.next((m) => m.type === 'error')).code, 'unknown_type');
    c.ws.send(Buffer.from('{"type":"ping"}'), { binary: true });
    assert.equal((await c.next((m) => m.type === 'error')).code, 'bad_message');
    c.send({ type: 'ping', ref: 'p' });
    assert.equal((await c.next((m) => m.type === 'pong')).ref, 'p');
    c.send({ type: 'auth', token: { not: 'a string' } });
    assert.equal((await c.next((m) => m.type === 'error')).code, 'auth_failed');
    assert.equal((await c.closed).code, 4001);
  });

  await t.test('rejects a second auth on an authenticated connection', async () => {
    const c = await h.authed();
    c.send({ type: 'auth', token: h.token() });
    assert.equal((await c.next((m) => m.type === 'error')).code, 'already_authenticated');
    await c.close();
  });

  await t.test('subscribes to permitted and public channels only', async () => {
    const c = await h.authed();
    assert.equal((await c.subscribe('orders')).type, 'subscribed');
    assert.equal((await c.subscribe('chat.room.9')).type, 'subscribed');
    assert.equal((await c.subscribe('announcements')).type, 'subscribed');
    assert.equal((await c.subscribe('status.db')).type, 'subscribed');
    const denied = await c.subscribe('user.43');
    assert.equal(denied.code, 'forbidden');
    const priv = await c.subscribe('private-anything');
    assert.equal(priv.code, 'forbidden');
    const invalid = await c.subscribe('bad channel');
    assert.equal(invalid.code, 'invalid_channel');
    await c.close();
  });

  await t.test('broadcasts dynamic events to channel subscribers; unsubscribe stops delivery', async () => {
    const a = await h.authed();
    const b = await h.authed({ sub: '43', channels: ['orders'] });
    const outsider = await h.authed({ sub: '44', channels: [] });
    await a.subscribe('orders');
    await b.subscribe('orders');

    const res = await h.publish({ channel: 'orders', event: 'custom.never-seen-before', data: { order_id: 1001, nested: [1, { x: null }] } });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.delivery, { scope: 'local', recipients: 2, sent: 2, dropped: 0 });
    for (const c of [a, b]) {
      const ev = await c.next((m) => m.type === 'event');
      assert.equal(ev.channel, 'orders');
      assert.equal(ev.target, 'channel');
      assert.equal(ev.event, 'custom.never-seen-before');
      assert.deepEqual(ev.data, { order_id: 1001, nested: [1, { x: null }] });
      assert.equal(ev.id, res.body.id);
      assert.ok(!Number.isNaN(Date.parse(ev.sentAt)));
    }
    await outsider.none((m) => m.type === 'event');

    b.send({ type: 'unsubscribe', channel: 'orders' });
    await b.next((m) => m.type === 'unsubscribed');
    const res2 = await h.publish({ channel: 'orders', event: 'again' });
    assert.equal(res2.body.delivery.sent, 1);
    await a.next((m) => m.event === 'again');
    await b.none((m) => m.event === 'again');
    await Promise.all([a.close(), b.close(), outsider.close()]);
  });

  await t.test('delivers user-targeted events to every connection of that user only', async () => {
    const tab1 = await h.authed({ sub: 'u-7' });
    const tab2 = await h.authed({ sub: 'u-7' });
    const other = await h.authed({ sub: 'u-8' });
    const res = await h.publish({ users: ['u-7'], event: 'notification', data: 'hi' });
    assert.equal(res.body.delivery.sent, 2);
    for (const c of [tab1, tab2]) {
      const ev = await c.next((m) => m.type === 'event');
      assert.equal(ev.target, 'user');
      assert.equal(ev.channel, null);
      assert.equal(ev.data, 'hi');
    }
    await other.none((m) => m.type === 'event');
    await Promise.all([tab1.close(), tab2.close(), other.close()]);
  });

  await t.test('removes closed connections from channel and user registries', async () => {
    const registry = h.server.ctx.channels.registry;
    const c = await h.authed({ sub: 'cleanup' });
    await c.subscribe('orders');
    assert.equal(registry.subscribers('shop', 'orders').size, 1);
    assert.equal(registry.userConnections('shop', 'cleanup').size, 1);
    c.ws.terminate();
    await waitFor(() => registry.subscribers('shop', 'orders').size === 0);
    assert.equal(registry.userConnections('shop', 'cleanup').size, 0);
    await waitFor(() => h.server.ctx.connections.size === 0);
    const res = await h.publish({ channel: 'orders', event: 'gone' });
    assert.equal(res.body.delivery.recipients, 0);
  });

  await t.test('POST /v1/disconnect closes a user\'s sockets with 4010', async () => {
    const victim = await h.authed({ sub: 'logout-me' });
    const bystander = await h.authed({ sub: 'stay' });
    const res = await h.signed('/v1/disconnect', { users: ['logout-me'] });
    assert.equal(res.status, 200);
    assert.equal(res.body.closed, 1);
    assert.equal((await victim.closed).code, 4010);
    bystander.send({ type: 'ping' });
    await bystander.next((m) => m.type === 'pong');
    await bystander.close();
  });
});

test('heartbeat terminates peers that stop answering pings', async (t) => {
  const h = await startServer({ DS_HEARTBEAT_INTERVAL_MS: '100' });
  t.after(() => h.stop());
  const alive = await h.authed();
  const dead = await h.authed({}, { wsOptions: { autoPong: false } });
  const closed = await dead.closed;
  assert.equal(closed.code, 1006, 'terminated without a close frame');
  await delay(250);
  alive.send({ type: 'ping' });
  await alive.next((m) => m.type === 'pong');
  assert.ok(h.server.ctx.metrics.get('ds_heartbeat_timeouts_total') >= 1);
  await alive.close();
});

test('sessions are closed with 4000 after DS_MAX_SESSION_SECONDS', async (t) => {
  const h = await startServer({ DS_MAX_SESSION_SECONDS: '1' });
  t.after(() => h.stop());
  const c = await h.authed();
  assert.equal((await c.closed).code, 4000);
});

test('graceful shutdown closes clients with 1001 and refuses new work', async () => {
  const h = await startServer();
  const c = await h.authed();
  const stopping = h.stop();
  assert.equal((await c.closed).code, 1001);
  await stopping;
  await assert.rejects(fetch(`${h.base}/healthz`));
});

test('graceful shutdown terminates clients that ignore the close handshake', async () => {
  const h = await startServer({ DS_SHUTDOWN_TIMEOUT_MS: '200' });
  const c = await h.authed();
  // Stop reading from the socket so the close handshake cannot complete.
  c.ws._socket.pause();
  const started = Date.now();
  await h.stop();
  assert.ok(Date.now() - started < 2000);
  assert.equal(h.server.ctx.connections.size, 0);
  c.ws.terminate();
});
