import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../../src/config/index.js';
import { ConfigError } from '../../src/utils/errors.js';

const SECRET = 'a'.repeat(32);
const apps = (overrides = {}) => JSON.stringify([{ id: 'shop', keys: [{ id: 'k1', secret: SECRET }], ...overrides }]);

test('loads defaults with a minimal valid app', () => {
  const config = loadConfig({ DS_APPS_JSON: apps() });
  assert.equal(config.port, 6001);
  assert.equal(config.wsPath, '/ws');
  assert.equal(config.host, '127.0.0.1', 'loopback by default');
  assert.equal(config.tokens.singleUse, true);
  assert.equal(config.apps[0].allowMissingOrigin, false);
  assert.ok(Buffer.isBuffer(config.apps[0].keys[0].secret));
  assert.ok(Object.isFrozen(config.limits));
});

test('requires at least one application', () => {
  assert.throws(() => loadConfig({}), (err) => err instanceof ConfigError && /No applications/.test(err.message));
});

test('rejects short secrets without echoing them', () => {
  assert.throws(
    () => loadConfig({ DS_APPS_JSON: apps({ keys: [{ id: 'k1', secret: 'short-secret-value' }] }) }),
    (err) => /at least 32/.test(err.message) && !err.message.includes('short-secret-value'),
  );
});

test('invalid JSON error does not leak file contents', () => {
  assert.throws(
    () => loadConfig({ DS_APPS_JSON: '{"secret": "abc' }),
    (err) => /not valid JSON/.test(err.message) && !err.message.includes('abc'),
  );
});

test('resolves secretEnv references', () => {
  const config = loadConfig({
    DS_APPS_JSON: apps({ keys: [{ id: 'k1', secretEnv: 'SHOP_K1' }] }),
    SHOP_K1: 'b'.repeat(40),
  });
  assert.equal(config.apps[0].keys[0].secret.toString(), 'b'.repeat(40));
  assert.throws(() => loadConfig({ DS_APPS_JSON: apps({ keys: [{ id: 'k1', secretEnv: 'MISSING' }] }) }), /MISSING/);
});

test('validates origins, channel patterns, ids, numbers and proxies', () => {
  const err = (() => {
    try {
      loadConfig({
        DS_APPS_JSON: JSON.stringify([
          { id: 'bad id!', keys: [] },
          { id: 'ok', keys: [{ id: 'k1', secret: SECRET }], allowedOrigins: ['https://a.test/path', 'ftp://x'], publicChannels: ['bad channel'] },
          { id: 'ok', keys: [{ id: 'k1', secret: SECRET }] },
        ]),
        DS_PORT: 'abc',
        DS_TRUSTED_PROXIES: 'not-an-ip',
        DS_TOKEN_SINGLE_USE: 'maybe',
      });
    } catch (e) {
      return e;
    }
  })();
  assert.ok(err instanceof ConfigError);
  const text = err.problems.join('\n');
  for (const fragment of ['app[0].id', 'https://a.test/path', 'ftp://x', 'bad channel', 'duplicated', 'DS_PORT', 'DS_TRUSTED_PROXIES', 'DS_TOKEN_SINGLE_USE']) {
    assert.ok(text.includes(fragment), `expected problem mentioning ${fragment}\n${text}`);
  }
});

test('falls back to PORT when DS_PORT is unset', () => {
  assert.equal(loadConfig({ DS_APPS_JSON: apps(), PORT: '3000' }).port, 3000);
  assert.equal(loadConfig({ DS_APPS_JSON: apps(), PORT: '3000', DS_PORT: '4000' }).port, 4000);
});

test('normalizes IPv4-mapped trusted proxies', () => {
  assert.deepEqual(loadConfig({ DS_APPS_JSON: apps(), DS_TRUSTED_PROXIES: '::ffff:10.0.0.1, ::1' }).trustedProxies, ['10.0.0.1', '::1']);
});
