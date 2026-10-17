import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SECRETS, startServer } from '../helpers/harness.js';

test('logs and client-visible errors never contain tokens or secrets', async (t) => {
  const h = await startServer({ DS_LOG_LEVEL: 'debug' });
  t.after(() => h.stop());

  const validToken = h.token();
  const ok = await h.connect();
  ok.send({ type: 'auth', token: validToken });
  await ok.next((m) => m.type === 'auth_ok');

  const forged = h.token({ secret: 'forged-secret-forged-secret-forged-secret' });
  const bad = await h.connect();
  bad.send({ type: 'auth', token: forged });
  const err = await bad.next((m) => m.type === 'error');
  assert.ok(!JSON.stringify(err).includes(forged));

  const failed = await h.publish({ channel: 'orders', event: 'e' }, { secret: 'w'.repeat(40) });
  assert.equal(failed.status, 401);
  await h.publish({ channel: 'orders', event: 'e' });
  await ok.close();

  const logs = h.logs.join('\n');
  assert.ok(logs.length > 0);
  for (const secret of [validToken, forged, SECRETS.shop.k1, SECRETS.shop.k2, failed.sig['X-DS-Signature']]) {
    assert.ok(!logs.includes(secret), `log output leaked ${secret.slice(0, 12)}…`);
  }
  // Every line is valid JSON with a level and message.
  for (const line of h.logs) {
    const entry = JSON.parse(line);
    assert.ok(entry.level && entry.msg);
  }
});
