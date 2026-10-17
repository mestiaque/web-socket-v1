import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SECRETS, startServer } from '../helpers/harness.js';

test('cross-application isolation', async (t) => {
  const h = await startServer();
  t.after(() => h.stop());

  await t.test('a token for app A cannot authenticate on an app B connection', async () => {
    const c = await h.connect({ app: 'parking' });
    c.send({ type: 'auth', token: h.token({}, { app: 'shop' }) });
    assert.equal((await c.next((m) => m.type === 'error')).code, 'auth_failed');
    assert.equal((await c.closed).code, 4001);
  });

  await t.test('a token claiming app B but signed with app A\'s secret is rejected', async () => {
    const c = await h.connect({ app: 'parking' });
    c.send({ type: 'auth', token: h.token({ appId: 'parking', keyId: 'p1', secret: SECRETS.shop.k1 }, { app: 'shop' }) });
    assert.equal((await c.next((m) => m.type === 'error')).code, 'auth_failed');
  });

  await t.test('same channel name in two apps never leaks', async () => {
    const shop = await h.authed({ channels: ['orders'] });
    const parking = await h.authed({ channels: ['orders'] }, { app: 'parking' });
    await shop.subscribe('orders');
    await parking.subscribe('orders');

    const res = await h.publish({ channel: 'orders', event: 'shop.only', data: 1 });
    assert.equal(res.body.delivery.sent, 1);
    await shop.next((m) => m.event === 'shop.only');
    await parking.none((m) => m.type === 'event');

    await h.publish({ channel: 'orders', event: 'parking.only' }, { app: 'parking' });
    await parking.next((m) => m.event === 'parking.only');
    await shop.none((m) => m.event === 'parking.only');
    await Promise.all([shop.close(), parking.close()]);
  });

  await t.test('same user id in two apps is two different users', async () => {
    const shop = await h.authed({ sub: '1' });
    const parking = await h.authed({ sub: '1' }, { app: 'parking' });
    const res = await h.publish({ users: ['1'], event: 'dm' }, { app: 'parking' });
    assert.equal(res.body.delivery.sent, 1);
    await parking.next((m) => m.event === 'dm');
    await shop.none((m) => m.type === 'event');
    const d = await h.signed('/v1/disconnect', { users: ['1'] }, { app: 'parking' });
    assert.equal(d.body.closed, 1);
    assert.equal((await parking.closed).code, 4010);
    shop.send({ type: 'ping' });
    await shop.next((m) => m.type === 'pong');
    await shop.close();
  });

  await t.test('app A credentials cannot publish as app B', async () => {
    const res = await h.publish({ channel: 'orders', event: 'x' }, { app: 'parking', key: 'p1', secret: SECRETS.shop.k1 });
    assert.equal(res.status, 401);
    const res2 = await h.publish({ channel: 'orders', event: 'x' }, { app: 'parking', key: 'k1', secret: SECRETS.shop.k1 });
    assert.equal(res2.status, 401);
  });

  await t.test('key rotation: removing a key invalidates tokens and requests signed with it', async () => {
    const rotated = await startServer({}, {
      apps: [{ id: 'shop', keys: [{ id: 'k2', secret: SECRETS.shop.k2 }], allowedOrigins: ['http://localhost:8000'] }],
    });
    try {
      const c = await rotated.connect();
      c.send({ type: 'auth', token: rotated.token({}, { key: 'k1' }) });
      assert.equal((await c.next((m) => m.type === 'error')).code, 'auth_failed');
      assert.equal((await rotated.publish({ channel: 'orders', event: 'e' }, { key: 'k1' })).status, 401);
      assert.equal((await rotated.publish({ channel: 'orders', event: 'e' }, { key: 'k2' })).status, 200);
      const ok = await rotated.authed({}, { key: 'k2' });
      await ok.close();
    } finally {
      await rotated.stop();
    }
  });
});
