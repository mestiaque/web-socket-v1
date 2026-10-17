import { test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { DynamicSocket } from '../../sdk/dynamicsocket.js';
import { ORIGIN, delay, startServer, waitFor } from '../helpers/harness.js';

const user = (sub, name) => ({ sub, user: { name }, channels: ['presence.*', 'orders'] });
const isPresence = (action, id) => (m) => m.type === 'presence' && m.action === action && (id === undefined || m.member.id === id);

test('presence channels (no leave grace)', async (t) => {
  const h = await startServer({ DS_PRESENCE_LEAVE_GRACE_MS: '0' });
  t.after(() => h.stop());

  await t.test('join returns members; others get member_added; joiner does not', async () => {
    const alice = await h.authed(user('1', 'Alice'));
    const first = await alice.subscribe('online');
    assert.deepEqual(first.presence, { count: 1, members: [{ id: '1', info: { name: 'Alice' } }] });

    const bob = await h.authed(user('2', 'Bob'));
    const second = await bob.subscribe('online');
    assert.equal(second.presence.count, 2);
    assert.deepEqual(second.presence.members.map((m) => m.id).sort(), ['1', '2']);

    const added = await alice.next(isPresence('member_added'));
    assert.deepEqual(added, { type: 'presence', action: 'member_added', channel: 'online', member: { id: '2', info: { name: 'Bob' } } });
    await bob.none(isPresence('member_added'));

    // a second tab of the same user is not a new member
    {
      const alice2 = await h.authed(user('1', 'Alice'));
      assert.equal((await alice2.subscribe('online')).presence.count, 2);
      await bob.none(isPresence('member_added', '1'));

      await alice2.close();
      await bob.none(isPresence('member_removed'));
    }

    // last connection leaving sends member_removed
    {
      await alice.close();
      const removed = await bob.next(isPresence('member_removed'));
      assert.deepEqual(removed.member, { id: '1' });
      const res = await h.signed('/v1/presence', { channel: 'online' });
      assert.deepEqual(res.body.channel.members, [{ id: '2', info: { name: 'Bob' } }]);
    }

    // unsubscribe also leaves
    {
      const carol = await h.authed(user('3', 'Carol'));
      await carol.subscribe('online');
      await bob.next(isPresence('member_added', '3'));
      carol.send({ type: 'unsubscribe', channel: 'online' });
      await bob.next(isPresence('member_removed', '3'));
      await carol.close();
    }
    await bob.close();
  });

  await t.test('presence channels still require authorization', async () => {
    const c = await h.authed({ sub: '9', channels: ['orders'] });
    assert.equal((await c.subscribe('presence.room.1')).code, 'forbidden');
    const granted = await h.authed({ sub: '10', channels: ['presence.room.*'] });
    assert.equal((await granted.subscribe('presence.room.1')).presence.count, 1);
    const plain = await granted.subscribe('announcements');
    assert.equal(plain.type, 'subscribed');
    assert.equal(plain.presence, undefined, 'non-presence channel has no member list');
    await Promise.all([c.close(), granted.close()]);
  });

  await t.test('presence is isolated per app', async () => {
    const shopUser = await h.authed(user('1', 'Shop'));
    await shopUser.subscribe('online');
    const parkingUser = await h.authed({ sub: '1', channels: ['online'] }, { app: 'parking' });
    const sub = await parkingUser.subscribe('online');
    assert.equal(sub.presence, undefined, '"online" is not a presence channel in the parking app');
    const res = await h.signed('/v1/presence', { users: ['1'], channel: 'online' }, { app: 'parking' });
    assert.equal(res.body.users['1'], true);
    assert.equal(res.body.channel.presence, false);
    await Promise.all([shopUser.close(), parkingUser.close()]);
  });
});

test('leave grace period hides reloads and delays member_removed', async (t) => {
  const h = await startServer({ DS_PRESENCE_LEAVE_GRACE_MS: '300' });
  t.after(() => h.stop());
  const watcher = await h.authed(user('w', 'Watcher'));
  await watcher.subscribe('online');

  const a = await h.authed(user('a', 'A'));
  await a.subscribe('online');
  await watcher.next(isPresence('member_added', 'a'));

  // "Page reload": leave and come back within the grace period.
  await a.close();
  const again = await h.authed(user('a', 'A'));
  assert.equal((await again.subscribe('online')).presence.count, 2);
  await watcher.none((m) => m.type === 'presence', 400);

  // Real departure: removed only after the grace period.
  const left = Date.now();
  await again.close();
  await watcher.none(isPresence('member_removed'), 150);
  await watcher.next(isPresence('member_removed', 'a'), 1000);
  assert.ok(Date.now() - left >= 280);
  await watcher.close();
});

test('presence member limit', async (t) => {
  const h = await startServer({ DS_PRESENCE_MAX_MEMBERS: '2', DS_PRESENCE_LEAVE_GRACE_MS: '0' });
  t.after(() => h.stop());
  const a = await h.authed(user('a', 'A'));
  const b = await h.authed(user('b', 'B'));
  const c = await h.authed(user('c', 'C'));
  const a2 = await h.authed(user('a', 'A'));
  await a.subscribe('online');
  await b.subscribe('online');
  assert.equal((await c.subscribe('online')).code, 'presence_full');
  assert.equal((await a2.subscribe('online')).type, 'subscribed', 'existing member may open more tabs');
  await Promise.all([a, b, c, a2].map((x) => x.close()));
});

test('POST /v1/presence', async (t) => {
  const h = await startServer({ DS_PRESENCE_LEAVE_GRACE_MS: '0' });
  t.after(() => h.stop());
  const a = await h.authed(user('42', 'Alice'));
  await a.subscribe('online');
  await a.subscribe('orders');

  const res = await h.signed('/v1/presence', { users: ['42', 43], channel: 'online' });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, {
    ok: true,
    users: { 42: true, 43: false },
    channel: { name: 'online', presence: true, subscriptions: 1, count: 1, members: [{ id: '42', info: { name: 'Alice' } }] },
  });
  const plain = await h.signed('/v1/presence', { channel: 'orders' });
  assert.deepEqual(plain.body.channel, { name: 'orders', presence: false, subscriptions: 1 });

  for (const bad of [{}, { users: [] }, { users: [''] }, { channel: 'bad name' }, { users: ['1'], extra: 1 }, []]) {
    assert.equal((await h.signed('/v1/presence', bad)).status, 422, JSON.stringify(bad));
  }
  const unsigned = await fetch(`${h.base}/v1/presence`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"users":["42"]}' });
  assert.equal(unsigned.status, 401);

  await a.close();
  await waitFor(async () => (await h.signed('/v1/presence', { users: ['42'] })).body.users['42'] === false);
});

test('SDK presence API: members, onPresence, reconnect sync', async (t) => {
  const h = await startServer({ DS_PRESENCE_LEAVE_GRACE_MS: '0' });
  t.after(() => h.stop());
  class OriginWS extends WebSocket {
    constructor(url) {
      super(url, { origin: ORIGIN });
    }
  }
  const client = new DynamicSocket({
    url: `ws://127.0.0.1:${h.port}/ws`,
    appId: 'shop',
    token: async () => h.token(user('me', 'Me')),
    WebSocket: OriginWS,
    minReconnectDelayMs: 20,
    maxReconnectDelayMs: 50,
  });
  t.after(() => client.dispose());

  const changes = [];
  const cb = (p) => changes.push([p.action, p.member?.id ?? null, p.members.map((m) => m.id).sort().join(',')]);
  client.onPresence('online', cb);
  client.onPresence('online', cb); // duplicate ignored
  await client.connect();
  const joined = await client.subscribe('online');
  assert.deepEqual(joined.members, [{ id: 'me', info: { name: 'Me' } }]);

  const other = await h.authed(user('you', 'You'));
  await other.subscribe('online');
  await waitFor(() => client.isMember('online', 'you'));
  await other.close();
  await waitFor(() => !client.isMember('online', 'you'));
  assert.deepEqual(changes, [
    ['sync', null, 'me'],
    ['member_added', 'you', 'me,you'],
    ['member_removed', 'you', 'me'],
  ]);

  // Connection drop: members are re-synced after automatic resubscribe.
  for (const conn of h.server.ctx.connections) conn.ws.terminate();
  await waitFor(() => changes.length === 4);
  assert.deepEqual(changes[3], ['sync', null, 'me']);
  assert.deepEqual(client.members('online'), [{ id: 'me', info: { name: 'Me' } }]);

  client.unsubscribe('online');
  assert.deepEqual(client.members('online'), []);
  await delay(50);
});
