import { test } from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { ORIGIN, startServer } from '../helpers/harness.js';

function upgradeStatus(url, headers = {}) {
  return new Promise((resolve) => {
    const ws = new WebSocket(url, { headers });
    ws.on('unexpected-response', (_req, res) => {
      resolve(res.statusCode);
      ws.terminate();
    });
    ws.on('open', () => {
      resolve(101);
      ws.terminate();
    });
    ws.on('error', () => {});
  });
}

test('handshake policy', async (t) => {
  const h = await startServer();
  t.after(() => h.stop());
  const base = `ws://127.0.0.1:${h.port}`;

  await t.test('origin allowlist', async () => {
    assert.equal(await upgradeStatus(h.wsUrl('shop'), { Origin: ORIGIN }), 101);
    assert.equal(await upgradeStatus(h.wsUrl('shop'), { Origin: 'https://evil.example' }), 403);
    assert.equal(await upgradeStatus(h.wsUrl('shop'), { Origin: 'http://localhost:8000.evil.example' }), 403);
    assert.equal(await upgradeStatus(h.wsUrl('shop'), { Origin: 'null' }), 403);
  });

  await t.test('missing Origin is refused unless the app allows non-browser clients', async () => {
    assert.equal(await upgradeStatus(h.wsUrl('shop')), 403);
    assert.equal(await upgradeStatus(h.wsUrl('parking')), 101);
  });

  await t.test('unknown app, missing app, wrong path', async () => {
    assert.equal(await upgradeStatus(h.wsUrl('ghost'), { Origin: ORIGIN }), 403);
    assert.equal(await upgradeStatus(`${base}/ws`, { Origin: ORIGIN }), 400);
    assert.equal(await upgradeStatus(`${base}/other?app=shop`, { Origin: ORIGIN }), 404);
  });

  await t.test('origin check does not replace authentication', async () => {
    const c = await h.connect({ app: 'parking', origin: null });
    c.send({ type: 'subscribe', channel: 'orders' });
    assert.equal((await c.next((m) => m.type === 'error')).code, 'not_authenticated');
    await c.close();
  });
});

test('connection exhaustion limits', async (t) => {
  await t.test('per-IP connection limit', async () => {
    const h = await startServer({ DS_MAX_CONNECTIONS_PER_IP: '2' });
    try {
      const a = await h.connect();
      const b = await h.connect();
      assert.equal(await upgradeStatus(h.wsUrl(), { Origin: ORIGIN }), 429);
      await a.close();
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(await upgradeStatus(h.wsUrl(), { Origin: ORIGIN }), 101);
      await b.close();
    } finally {
      await h.stop();
    }
  });

  await t.test('global and per-app connection limits', async () => {
    const h = await startServer({ DS_MAX_CONNECTIONS: '2' }, {
      apps: [
        { id: 'shop', keys: [{ id: 'k1', secret: 'x'.repeat(32) }], allowedOrigins: [ORIGIN], maxConnections: 1 },
        { id: 'parking', keys: [{ id: 'p1', secret: 'y'.repeat(32) }], allowMissingOrigin: true },
      ],
    });
    try {
      const a = await h.connect();
      assert.equal(await upgradeStatus(h.wsUrl('shop'), { Origin: ORIGIN }), 503, 'app limit');
      const b = await h.connect({ app: 'parking', origin: null });
      assert.equal(await upgradeStatus(h.wsUrl('parking')), 503, 'global limit');
      await Promise.all([a.close(), b.close()]);
    } finally {
      await h.stop();
    }
  });

  await t.test('upgrade attempts per IP are rate limited', async () => {
    const h = await startServer({ DS_UPGRADES_PER_IP_PER_MIN: '3' });
    try {
      const statuses = [];
      for (let i = 0; i < 4; i++) statuses.push(await upgradeStatus(h.wsUrl(), { Origin: ORIGIN }));
      assert.deepEqual(statuses, [101, 101, 101, 429]);
    } finally {
      await h.stop();
    }
  });

  await t.test('X-Forwarded-For from an untrusted peer cannot dodge per-IP limits', async () => {
    const h = await startServer({ DS_MAX_CONNECTIONS_PER_IP: '1' });
    try {
      const a = await h.connect({ wsOptions: { headers: { 'X-Forwarded-For': '1.1.1.1' } } });
      assert.equal(await upgradeStatus(h.wsUrl(), { Origin: ORIGIN, 'X-Forwarded-For': '2.2.2.2' }), 429);
      await a.close();
    } finally {
      await h.stop();
    }
  });

  await t.test('X-Forwarded-For is honoured from a configured trusted proxy', async () => {
    const h = await startServer({ DS_MAX_CONNECTIONS_PER_IP: '1', DS_TRUSTED_PROXIES: '127.0.0.1' });
    try {
      const a = await h.connect({ wsOptions: { headers: { 'X-Forwarded-For': '1.1.1.1' } } });
      assert.equal(await upgradeStatus(h.wsUrl(), { Origin: ORIGIN, 'X-Forwarded-For': '2.2.2.2' }), 101);
      assert.equal(await upgradeStatus(h.wsUrl(), { Origin: ORIGIN, 'X-Forwarded-For': '1.1.1.1' }), 429);
      await a.close();
    } finally {
      await h.stop();
    }
  });
});
