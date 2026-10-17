import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalString, sha256Hex, signRequest, verifyRequestSignature } from '../../src/auth/request-signature.js';
import { AppRegistry } from '../../src/auth/app-registry.js';
import { ErrorCode } from '../../src/utils/errors.js';

const SECRET = 's'.repeat(32);
const registry = new AppRegistry([{ id: 'shop', keys: [{ id: 'k1', secret: Buffer.from(SECRET) }] }]);
const NOW = Date.UTC(2026, 0, 1);
const body = '{"channel":"orders","event":"x"}';

function verify(overrides = {}, headerOverrides = {}) {
  const headers = signRequest({ method: 'POST', path: '/v1/publish', body, appId: 'shop', keyId: 'k1', secret: SECRET, now: NOW });
  const lower = Object.fromEntries(Object.entries({ ...headers, ...headerOverrides }).map(([k, v]) => [k.toLowerCase(), v]));
  return verifyRequestSignature({ method: 'POST', path: '/v1/publish', headers: lower, body, registry, toleranceSeconds: 300, now: NOW, ...overrides });
}
const code = (fn) => {
  try {
    fn();
  } catch (err) {
    return err.code;
  }
  return 'no error';
};

test('canonical string format is stable', () => {
  assert.equal(
    canonicalString({ method: 'post', path: '/v1/publish', appId: 'a', keyId: 'k', timestamp: 1, nonce: 'n', bodyHash: 'h' }),
    'DS1-HMAC-SHA256\nPOST\n/v1/publish\na\nk\n1\nn\nh',
  );
  assert.equal(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
});

test('accepts a correctly signed request', () => {
  const result = verify();
  assert.equal(result.appId, 'shop');
  assert.equal(result.keyId, 'k1');
});

test('rejects body, path, method tampering', () => {
  assert.equal(code(() => verify({ body: body.replace('orders', 'admin') })), ErrorCode.INVALID_SIGNATURE);
  assert.equal(code(() => verify({ path: '/v1/disconnect' })), ErrorCode.INVALID_SIGNATURE);
  assert.equal(code(() => verify({ method: 'PUT' })), ErrorCode.INVALID_SIGNATURE);
});

test('rejects header tampering, unknown app/key, malformed headers', () => {
  assert.equal(code(() => verify({}, { 'X-DS-Nonce': 'a'.repeat(20) })), ErrorCode.INVALID_SIGNATURE);
  assert.equal(code(() => verify({}, { 'X-DS-App': 'ghost' })), ErrorCode.INVALID_SIGNATURE);
  assert.equal(code(() => verify({}, { 'X-DS-Key': 'k9' })), ErrorCode.INVALID_SIGNATURE);
  assert.equal(code(() => verify({}, { 'X-DS-Signature': 'zz' })), ErrorCode.INVALID_SIGNATURE);
  assert.equal(code(() => verify({}, { 'X-DS-Timestamp': '1.5' })), ErrorCode.INVALID_SIGNATURE);
  assert.equal(code(() => verify({}, { 'X-DS-Nonce': 'short' })), ErrorCode.INVALID_SIGNATURE);
  assert.equal(code(() => verify({}, { 'X-DS-Signature': undefined })), ErrorCode.INVALID_SIGNATURE);
});

test('rejects timestamps outside the tolerance window', () => {
  assert.doesNotThrow(() => verify({ now: NOW + 299_000 }));
  assert.equal(code(() => verify({ now: NOW + 301_000 })), ErrorCode.STALE_REQUEST);
  assert.equal(code(() => verify({ now: NOW - 301_000 })), ErrorCode.STALE_REQUEST);
});
