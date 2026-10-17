import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { SECRETS, startServer } from '../helpers/harness.js';

const phpAvailable = spawnSync('php', ['--version']).status === 0;
const script = fileURLToPath(new URL('../../examples/laravel/tests/cross-language.php', import.meta.url));

test('PHP Signer output is accepted by the server (token + signed publish)', { skip: !phpAvailable && 'php not installed' }, async (t) => {
  const h = await startServer();
  t.after(() => h.stop());
  const out = JSON.parse(execFileSync('php', [script, 'shop', 'k1', SECRETS.shop.k1], { encoding: 'utf8' }));

  const client = await h.connect();
  client.send({ type: 'auth', token: out.token });
  const ok = await client.next((m) => m.type === 'auth_ok' || m.type === 'error');
  assert.equal(ok.type, 'auth_ok', JSON.stringify(ok));
  assert.equal(ok.sub, '42');
  assert.equal((await client.subscribe('orders')).type, 'subscribed');

  const res = await fetch(`${h.base}/v1/publish`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...out.headers },
    body: out.body,
  });
  const json = await res.json();
  assert.equal(res.status, 200, JSON.stringify(json));
  assert.equal(json.delivery.sent, 2, 'channel subscriber + user target');

  const event = await client.next((m) => m.type === 'event' && m.target === 'channel');
  assert.deepEqual(event.data, { order_id: 1001, note: 'Ünïcödé / slashes' });
  await client.next((m) => m.type === 'event' && m.target === 'user');
  await client.close();
});
