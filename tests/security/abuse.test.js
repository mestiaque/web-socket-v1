import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect as netConnect } from 'node:net';
import { randomBytes } from 'node:crypto';
import { ORIGIN, delay, startServer, waitFor } from '../helpers/harness.js';

test('inbound payload limit closes the socket with 1009', async (t) => {
  const h = await startServer({ DS_MAX_PAYLOAD_BYTES: '1024' });
  t.after(() => h.stop());
  const c = await h.authed();
  c.send({ type: 'ping', pad: 'x'.repeat(2000) });
  assert.equal((await c.closed).code, 1009);
  await waitFor(() => h.server.ctx.connections.size === 0);
});

test('invalid WebSocket frames are rejected by the protocol library (1002)', async (t) => {
  const h = await startServer();
  t.after(() => h.stop());
  const socket = netConnect(h.port, '127.0.0.1');
  t.after(() => socket.destroy());
  await new Promise((r) => socket.once('connect', r));
  socket.write(
    `GET /ws?app=shop HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
      `Sec-WebSocket-Key: ${randomBytes(16).toString('base64')}\r\nSec-WebSocket-Version: 13\r\nOrigin: ${ORIGIN}\r\n\r\n`,
  );
  let buffer = Buffer.alloc(0);
  socket.on('data', (d) => {
    buffer = Buffer.concat([buffer, d]);
  });
  await waitFor(() => buffer.includes('"hello"'));
  // Client frames MUST be masked (RFC 6455 §5.1); send an unmasked text frame.
  const start = buffer.length;
  socket.write(Buffer.from([0x81, 0x02, 0x68, 0x69]));
  await waitFor(() => buffer.length > start + 3);
  const frame = buffer.subarray(start);
  assert.equal(frame[0], 0x88, 'close frame');
  assert.equal(frame.readUInt16BE(2), 1002);
  await waitFor(() => h.server.ctx.connections.size === 0);
});

test('malformed and hostile JSON never crashes the server', async (t) => {
  const h = await startServer({ DS_CLIENT_RATE_BURST: '100' });
  t.after(() => h.stop());
  const c = await h.authed();
  const hostile = [
    '', 'null', '[]', '"str"', '{"type":null}', '{"type":"subscribe"}', '{"type":"subscribe","channel":{"$ne":1}}',
    '{"type":"subscribe","channel":"' + 'a'.repeat(5000) + '"}', '{"type":"__proto__"}', '{"type":"constructor"}',
    '{"type":"auth","token":"' + 'a.'.repeat(3000) + '"}', '{"type":"unsubscribe","channel":["orders"]}', '\u0000\u0001',
  ];
  for (const payload of hostile) c.send(payload);
  await waitFor(() => c.messages.filter((m) => m.type === 'error').length === hostile.length);
  c.send({ type: 'ping' });
  await c.next((m) => m.type === 'pong');
  assert.equal({}.polluted, undefined);
  const health = await fetch(`${h.base}/healthz`);
  assert.equal(health.status, 200);
  await c.close();
});

test('per-connection message rate limit warns, then closes with 4029', async (t) => {
  const h = await startServer({ DS_CLIENT_RATE_PER_SEC: '1', DS_CLIENT_RATE_BURST: '3', DS_CLIENT_RATE_VIOLATIONS_BEFORE_CLOSE: '3' });
  t.after(() => h.stop());
  const c = await h.connect();
  for (let i = 0; i < 10; i++) c.send({ type: 'ping' });
  assert.equal((await c.closed).code, 4029);
  assert.equal(c.messages.filter((m) => m.type === 'pong').length, 3);
  assert.equal(c.messages.filter((m) => m.code === 'rate_limited').length, 3);
});

test('authentication brute force is throttled per IP', async (t) => {
  const h = await startServer({ DS_AUTH_FAILURES_PER_IP_PER_MIN: '3' });
  t.after(() => h.stop());
  const codes = [];
  for (let i = 0; i < 4; i++) {
    const c = await h.connect();
    c.send({ type: 'auth', token: 'garbage.token.value' });
    codes.push((await c.next((m) => m.type === 'error')).code);
    await c.closed;
  }
  assert.deepEqual(codes, ['auth_failed', 'auth_failed', 'auth_failed', 'rate_limited']);
  // Even a valid token is refused while throttled.
  const c = await h.connect();
  c.send({ type: 'auth', token: h.token() });
  assert.equal((await c.next((m) => m.type === 'error')).code, 'rate_limited');
  assert.equal((await c.closed).code, 4029);
});

test('subscription limit per connection', async (t) => {
  const h = await startServer({ DS_MAX_SUBSCRIPTIONS_PER_CONNECTION: '2' });
  t.after(() => h.stop());
  const c = await h.authed();
  await c.subscribe('chat.room.1');
  await c.subscribe('chat.room.2');
  assert.equal((await c.subscribe('chat.room.3')).code, 'subscription_limit');
  await c.close();
});

test('slow clients are disconnected without affecting fast clients', async (t) => {
  const h = await startServer({
    DS_MAX_BUFFERED_BYTES: '65536',
    DS_MAX_PUBLISH_BODY_BYTES: '131072',
    DS_PUBLISH_RATE_PER_SEC: '100000',
    DS_PUBLISH_RATE_BURST: '100000',
    DS_SLOW_CONSUMER_GRACE_MS: '100',
  });
  t.after(() => h.stop());
  const fast = await h.authed({ sub: 'fast' });
  const slow = await h.authed({ sub: 'slow' });
  await fast.subscribe('orders');
  await slow.subscribe('orders');
  slow.ws._socket.pause(); // stop reading: kernel buffers, then server buffer, fill up

  const data = 'x'.repeat(60_000);
  let dropped = 0;
  let published = 0;
  while (dropped === 0 && published < 1000) {
    const res = await h.publish({ channel: 'orders', event: 'bulk', data });
    assert.equal(res.status, 200);
    dropped += res.body.delivery.dropped;
    published += 1;
  }
  assert.equal(dropped, 1, `slow client should be dropped (published ${published})`);
  await waitFor(() => h.server.ctx.connections.size === 1, 3000);
  assert.equal(h.server.ctx.metrics.get('ds_slow_consumer_disconnects_total', { app: 'shop' }), 1);

  await waitFor(() => fast.messages.filter((m) => m.event === 'bulk').length === published, 5000);
  const res = await h.publish({ channel: 'orders', event: 'after' });
  assert.equal(res.body.delivery.sent, 1);
  await fast.next((m) => m.event === 'after');
  await fast.close();
  slow.ws.terminate();
});

test('nonce store fails closed when full', async (t) => {
  const h = await startServer({ DS_NONCE_STORE_MAX: '100' });
  t.after(() => h.stop());
  for (let i = 0; i < 100; i++) assert.equal((await h.publish({ channel: 'orders', event: 'e' })).status, 200);
  const res = await h.publish({ channel: 'orders', event: 'e' });
  assert.equal(res.status, 503);
  assert.equal(res.body.error.code, 'capacity_exceeded');
  await delay(0);
});
