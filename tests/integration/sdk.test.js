import { test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { DynamicSocket, State } from '../../sdk/dynamicsocket.js';
import { ORIGIN, startServer, waitFor } from '../helpers/harness.js';

class BrowserLikeWebSocket extends WebSocket {
  constructor(url) {
    super(url, { origin: ORIGIN });
  }
}

function makeClient(h, overrides = {}) {
  let tokenCalls = 0;
  const client = new DynamicSocket({
    url: `ws://127.0.0.1:${h.port}/ws`,
    appId: 'shop',
    token: async () => {
      tokenCalls += 1;
      return h.token(overrides.claims ?? {});
    },
    WebSocket: BrowserLikeWebSocket,
    minReconnectDelayMs: 20,
    maxReconnectDelayMs: 100,
    ...overrides,
  });
  return { client, tokenCalls: () => tokenCalls };
}

const nextEvent = (client, name) => new Promise((resolve) => {
  const off = client.on(name, (p) => {
    off();
    resolve(p);
  });
});

test('SDK: connect, subscribe, listen with dedupe, filters and removal', async (t) => {
  const h = await startServer();
  t.after(() => h.stop());
  const { client } = makeClient(h);
  t.after(() => client.dispose());

  const states = [];
  client.on('state', ({ state }) => states.push(state));
  await client.connect();
  assert.equal(client.state, State.CONNECTED);
  assert.deepEqual(states, ['connecting', 'authenticating', 'connected']);
  await client.subscribe('orders');
  await client.subscribe('announcements');

  const received = [];
  const cb = (data, meta) => received.push(['cb', data, meta.channel]);
  client.listen('order.created', cb);
  client.listen('order.created', cb); // duplicate ignored
  client.listen('*', (data, meta) => received.push(['any', meta.event]));
  const offFiltered = client.listen('order.created', (data) => received.push(['announcements-only', data]), { channel: 'announcements' });

  await h.publish({ channel: 'orders', event: 'order.created', data: { id: 1 } });
  await h.publish({ channel: 'announcements', event: 'order.created', data: { id: 2 } });
  await waitFor(() => received.length === 5);
  assert.deepEqual(received, [
    ['cb', { id: 1 }, 'orders'],
    ['any', 'order.created'],
    ['cb', { id: 2 }, 'announcements'],
    ['any', 'order.created'],
    ['announcements-only', { id: 2 }],
  ]);

  offFiltered();
  client.stopListening('*', received.find(() => false)); // no-op for unknown callback
  received.length = 0;
  await h.publish({ channel: 'announcements', event: 'order.created', data: { id: 3 } });
  await waitFor(() => received.length === 2);
  assert.ok(!received.some(([k]) => k === 'announcements-only'));
});

test('SDK: forbidden subscription rejects and is not restored', async (t) => {
  const h = await startServer();
  t.after(() => h.stop());
  const { client } = makeClient(h);
  t.after(() => client.dispose());
  const errors = [];
  client.on('subscription_error', (e) => errors.push(e));
  await client.connect();
  await assert.rejects(client.subscribe('admin.secrets'), (err) => err.code === 'forbidden');
  assert.deepEqual(errors, [{ channel: 'admin.secrets', code: 'forbidden', message: 'Not authorized for this channel' }]);
  assert.deepEqual(client.subscriptions(), []);
});

test('SDK: subscriptions requested before connect are sent after auth', async (t) => {
  const h = await startServer();
  t.after(() => h.stop());
  const { client } = makeClient(h);
  t.after(() => client.dispose());
  const pending = client.subscribe('orders');
  await client.connect();
  await pending;
  assert.equal(h.server.ctx.channels.registry.subscribers('shop', 'orders').size, 1);
});

test('SDK: reconnects with a fresh token and restores subscriptions after a drop', async (t) => {
  const h = await startServer();
  t.after(() => h.stop());
  const { client, tokenCalls } = makeClient(h);
  t.after(() => client.dispose());
  await client.connect();
  await client.subscribe('orders');

  const reconnected = nextEvent(client, 'connected');
  for (const conn of h.server.ctx.connections) conn.ws.terminate();
  await reconnected;
  assert.equal(tokenCalls(), 2, 'a new single-use token is fetched for each connection');
  await waitFor(() => h.server.ctx.channels.registry.subscribers('shop', 'orders').size === 1);

  const got = new Promise((resolve) => client.listen('after.reconnect', resolve));
  await h.publish({ channel: 'orders', event: 'after.reconnect', data: 'ok' });
  assert.equal(await got, 'ok');
});

test('SDK: survives a full server restart on the same port', async (t) => {
  const h1 = await startServer();
  const { client } = makeClient(h1);
  t.after(() => client.dispose());
  await client.connect();
  await client.subscribe('orders');
  const disconnected = nextEvent(client, 'disconnected');
  await h1.stop();
  assert.equal((await disconnected).willReconnect, true);

  const h2 = await startServer({ DS_PORT: String(h1.port) });
  t.after(() => h2.stop());
  await waitFor(() => h2.server.ctx.channels.registry.subscribers('shop', 'orders').size === 1, 3000);
  const got = new Promise((resolve) => client.listen('restarted', resolve));
  await h2.publish({ channel: 'orders', event: 'restarted', data: 1 });
  assert.equal(await got, 1);
});

test('SDK: static token that fails stops without reconnect loops', async (t) => {
  const h = await startServer();
  t.after(() => h.stop());
  const client = new DynamicSocket({
    url: `ws://127.0.0.1:${h.port}/ws`,
    appId: 'shop',
    token: 'not-a-valid-token',
    WebSocket: BrowserLikeWebSocket,
    minReconnectDelayMs: 10,
  });
  t.after(() => client.dispose());
  const authErrors = [];
  client.on('auth_error', (e) => authErrors.push(e.code));
  await assert.rejects(client.connect(), (err) => err.code === 4001);
  assert.equal(client.state, State.DISCONNECTED);
  assert.deepEqual(authErrors, ['auth_failed']);
});

test('SDK: token provider failures are bounded by maxAuthFailures', async (t) => {
  const h = await startServer();
  t.after(() => h.stop());
  let calls = 0;
  const client = new DynamicSocket({
    url: `ws://127.0.0.1:${h.port}/ws`,
    appId: 'shop',
    token: async () => {
      calls += 1;
      throw new Error('401 from /dynamicsocket/token');
    },
    WebSocket: BrowserLikeWebSocket,
    minReconnectDelayMs: 5,
    maxReconnectDelayMs: 10,
    maxAuthFailures: 3,
  });
  t.after(() => client.dispose());
  await assert.rejects(client.connect());
  assert.equal(calls, 3);
  assert.equal(client.state, State.DISCONNECTED);
});

test('SDK: server-initiated disconnect (logout) does not reconnect by default', async (t) => {
  const h = await startServer();
  t.after(() => h.stop());
  const { client, tokenCalls } = makeClient(h, { claims: { sub: 'bye' } });
  t.after(() => client.dispose());
  await client.connect();
  const disconnected = nextEvent(client, 'disconnected');
  await h.signed('/v1/disconnect', { users: ['bye'] });
  const info = await disconnected;
  assert.equal(info.code, 4010);
  assert.equal(info.willReconnect, false);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(tokenCalls(), 1);
  assert.equal(client.state, State.DISCONNECTED);
});

test('SDK: client heartbeat detects an unresponsive server and reconnects', async (t) => {
  const h = await startServer();
  t.after(() => h.stop());
  const { client } = makeClient(h, { heartbeatIntervalMs: 50, heartbeatTimeoutMs: 50 });
  t.after(() => client.dispose());
  await client.connect();
  const [conn] = h.server.ctx.connections;
  conn.ws._socket.pause(); // server stops reading: pings go unanswered
  const info = await nextEvent(client, 'disconnected');
  assert.equal(info.reason, 'heartbeat_timeout');
  await nextEvent(client, 'connected');
});

test('SDK: only control messages may be emitted; no secrets in the SDK source', async (t) => {
  const h = await startServer();
  t.after(() => h.stop());
  const { client } = makeClient(h);
  t.after(() => client.dispose());
  assert.throws(() => client.emitControlMessage({ type: 'ping' }), /Not connected/);
  await client.connect();
  client.emitControlMessage({ type: 'ping' });
  for (const type of ['event', 'publish', 'auth', 'broadcast']) {
    assert.throws(() => client.emitControlMessage({ type, channel: 'orders', event: 'x' }), /Only ping/);
  }
  const { readFile } = await import('node:fs/promises');
  const source = await readFile(new URL('../../sdk/dynamicsocket.js', import.meta.url), 'utf8');
  assert.ok(!/createHmac|crypto\.subtle|node:crypto|secret\s*[:=]/i.test(source), 'SDK must not contain signing code or secrets');
});

test('SDK: dispose releases listeners and stops reconnecting', async (t) => {
  const h = await startServer();
  t.after(() => h.stop());
  const { client, tokenCalls } = makeClient(h);
  await client.connect();
  client.listen('x', () => {});
  client.dispose();
  assert.equal(client.state, State.DISPOSED);
  assert.equal(client.listeners.length, 0);
  await assert.rejects(client.connect(), /disposed/);
  await assert.rejects(client.subscribe('orders'), /disposed/);
  await waitFor(() => h.server.ctx.connections.size === 0);
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(tokenCalls(), 1);
});

test('SDK: reconnect delays use exponential backoff with jitter', async () => {
  class FailingSocket {
    static OPEN = 1;
    constructor() {
      this.readyState = 0;
      setTimeout(() => this.onclose?.({ code: 1006, reason: '' }), 0);
    }
    close() {}
  }
  const client = new DynamicSocket({
    url: 'ws://unused/ws',
    appId: 'shop',
    token: async () => 't',
    WebSocket: FailingSocket,
    minReconnectDelayMs: 1,
    maxReconnectDelayMs: 16,
  });
  const delays = [];
  client.on('reconnect_scheduled', ({ delayMs }) => delays.push(delayMs));
  client.connect().catch(() => {});
  await waitFor(() => delays.length >= 7);
  client.dispose();
  const caps = [1, 2, 4, 8, 16, 16, 16];
  caps.forEach((cap, i) => assert.ok(delays[i] >= Math.floor(cap / 2) && delays[i] <= cap, `attempt ${i}: ${delays[i]} not in [${cap / 2}, ${cap}]`));
});
