import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLogger, redact } from '../../src/observability/logger.js';
import { Metrics } from '../../src/observability/metrics.js';

test('redacts sensitive keys recursively and truncates long strings', () => {
  const out = redact({
    token: 'abc.def.ghi',
    nested: { clientSecret: 's3cr3t', Authorization: 'Bearer x', 'x-ds-signature': 'ff', ok: 'visible' },
    list: [{ password: 'p' }],
    long: 'x'.repeat(2000),
    buf: Buffer.from('secret'),
  });
  const json = JSON.stringify(out);
  for (const leaked of ['abc.def.ghi', 's3cr3t', 'Bearer x', '"ff"']) assert.ok(!json.includes(leaked), leaked);
  assert.equal(out.nested.ok, 'visible');
  assert.ok(out.long.length < 600);
  assert.equal(out.buf, '[Buffer 6 bytes]');
});

test('logger writes JSON lines, honours levels, and applies redaction', () => {
  const lines = [];
  const log = createLogger({ level: 'info', write: (l) => lines.push(l), base: { svc: 'ds' } });
  log.debug('hidden');
  log.info('hello', { token: 'tkn', n: 1 });
  log.child({ connectionId: 'c1' }).warn('child');
  assert.equal(lines.length, 2);
  const first = JSON.parse(lines[0]);
  assert.equal(first.msg, 'hello');
  assert.equal(first.token, '[REDACTED]');
  assert.equal(first.svc, 'ds');
  assert.equal(JSON.parse(lines[1]).connectionId, 'c1');
});

test('metrics render Prometheus text', () => {
  const m = new Metrics();
  m.counter('ds_x_total', 'X');
  m.inc('ds_x_total', { app: 'a"b' });
  m.inc('ds_x_total', { app: 'a"b' }, 2);
  m.gauge('ds_g', 'G', () => 5);
  const text = m.render();
  assert.match(text, /ds_x_total\{app="a_b"\} 3/);
  assert.match(text, /# TYPE ds_g gauge\nds_g 5/);
});
