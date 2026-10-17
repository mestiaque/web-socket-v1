#!/usr/bin/env node
/**
 * End-to-end test: real DynamicSocket process + real Laravel app (built by
 * tests/e2e/setup-laravel.sh) + queue worker + headless Google Chrome.
 *
 *   tests/e2e/setup-laravel.sh /tmp/ds-laravel
 *   node tests/e2e/laravel-browser.e2e.mjs /tmp/ds-laravel
 *
 * Requires: php, composer (for setup), google-chrome or chromium (CHROME_BIN).
 * Exits non-zero on the first failed check.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import WebSocket from 'ws';
import { signRequest } from '../../src/auth/request-signature.js';

const APP_DIR = resolve(process.argv[2] ?? '');
const REPO = resolve(new URL('../..', import.meta.url).pathname);
const CHROME = process.env.CHROME_BIN ?? 'google-chrome';
const SECRET = process.env.DYNAMICSOCKET_SECRET ?? 'e2e-secret-0123456789abcdef0123456789abcdef';
const DS = 'http://127.0.0.1:6201';
const LARAVEL = 'http://127.0.0.1:8000';
const GRACE_MS = 1500;

const children = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const step = (msg) => process.stdout.write(`\n▶ ${msg}\n`);
const ok = (msg) => process.stdout.write(`  ✔ ${msg}\n`);

function start(name, cmd, args, opts = {}) {
  const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], ...opts });
  child.output = '';
  child.stdout.on('data', (d) => (child.output += d));
  child.stderr.on('data', (d) => (child.output += d));
  child.name = name;
  children.push(child);
  return child;
}

async function waitFor(fn, what, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (last) return last;
    } catch (err) {
      last = err;
    }
    await sleep(100);
  }
  throw new Error(`timed out waiting for ${what} (last: ${last instanceof Error ? last.message : JSON.stringify(last)})`);
}

// ------------------------------------------------------------ minimal CDP client
class Cdp {
  static async connect(url) {
    const cdp = new Cdp();
    cdp.ws = new WebSocket(url, { perMessageDeflate: false });
    cdp.id = 0;
    cdp.pending = new Map();
    cdp.listeners = [];
    cdp.ws.on('message', (raw) => {
      const msg = JSON.parse(raw);
      if (msg.id && cdp.pending.has(msg.id)) {
        const { resolve: res, reject } = cdp.pending.get(msg.id);
        cdp.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else res(msg.result);
      } else if (msg.method) {
        for (const l of cdp.listeners) l(msg);
      }
    });
    await new Promise((r, j) => {
      cdp.ws.once('open', r);
      cdp.ws.once('error', j);
    });
    return cdp;
  }

  send(method, params = {}, sessionId) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params, ...(sessionId && { sessionId }) }));
    return new Promise((res, reject) => this.pending.set(id, { resolve: res, reject }));
  }

  /** Opens a page in a fresh browser context (separate cookies = separate user). */
  async newPage(label) {
    const { browserContextId } = await this.send('Target.createBrowserContext');
    const { targetId } = await this.send('Target.createTarget', { url: 'about:blank', browserContextId });
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    await this.send('Runtime.enable', {}, sessionId);
    await this.send('Page.enable', {}, sessionId);
    const page = { label, targetId, sessionId, errors: [] };
    this.listeners.push((msg) => {
      if (msg.sessionId !== sessionId) return;
      if (msg.method === 'Runtime.exceptionThrown') page.errors.push(msg.params.exceptionDetails.exception?.description ?? msg.params.exceptionDetails.text);
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') page.errors.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
    });
    page.goto = (url) => this.send('Page.navigate', { url }, sessionId);
    page.eval = async (expression) => {
      const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, sessionId);
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    };
    page.close = () => this.send('Target.closeTarget', { targetId });
    return page;
  }
}

const recorder = (page) => page.eval('window.__e2e ? JSON.parse(JSON.stringify(window.__e2e)) : null');
const csrfFetch = (path, method = 'POST', body) => `fetch('${path}', { method: '${method}', credentials: 'same-origin',
  headers: { 'Accept': 'application/json', 'Content-Type': 'application/json',
             'X-CSRF-TOKEN': document.querySelector('meta[name=csrf-token]').content },
  ${body ? `body: JSON.stringify(${JSON.stringify(body)}),` : ''} }).then(async (r) => ({ status: r.status, body: await r.text() }))`;

async function dsPresence(payload) {
  const body = JSON.stringify(payload);
  const headers = signRequest({ method: 'POST', path: '/v1/presence', body, appId: 'shop', keyId: 'k1', secret: SECRET });
  const res = await fetch(`${DS}/v1/presence`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body });
  return res.json();
}

async function main() {
  assert.ok(APP_DIR && APP_DIR !== REPO, 'usage: node tests/e2e/laravel-browser.e2e.mjs <laravel-app-dir>');

  step('Starting DynamicSocket, Laravel (artisan serve), queue worker and Chrome');
  start('dynamicsocket', process.execPath, [join(REPO, 'src/server.js')], {
    env: {
      ...process.env,
      DS_ENV_FILE: '/dev/null',
      DS_HOST: '127.0.0.1',
      DS_PORT: '6201',
      DS_LOG_LEVEL: 'info',
      DS_PRESENCE_LEAVE_GRACE_MS: String(GRACE_MS),
      DS_APPS_JSON: JSON.stringify([{
        id: 'shop',
        keys: [{ id: 'k1', secret: SECRET }],
        allowedOrigins: [LARAVEL],
        publicChannels: ['online'],
        presenceChannels: ['online', 'presence.*'],
      }]),
    },
  });
  start('laravel', 'php', ['artisan', 'serve', '--host=127.0.0.1', '--port=8000', '--no-reload'], { cwd: APP_DIR, env: { ...process.env, PHP_CLI_SERVER_WORKERS: '4' } });
  start('queue', 'php', ['artisan', 'queue:work', '--sleep=0', '--tries=5'], { cwd: APP_DIR });
  const profile = mkdtempSync(join(tmpdir(), 'ds-e2e-chrome-'));
  const chrome = start('chrome', CHROME, ['--headless=new', '--remote-debugging-port=9333', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check', '--disable-gpu', 'about:blank']);

  await waitFor(async () => (await fetch(`${DS}/healthz`)).ok, 'DynamicSocket');
  await waitFor(async () => (await fetch(`${LARAVEL}/up`)).ok, 'Laravel');
  const version = await waitFor(async () => (await fetch('http://127.0.0.1:9333/json/version')).json(), 'Chrome');
  ok(`all processes up (${version.Browser})`);
  const cdp = await Cdp.connect(version.webSocketDebuggerUrl);

  try {
    step('Alice logs in; browser fetches a token from Laravel and connects');
    const alice = await cdp.newPage('alice');
    await alice.goto(`${LARAVEL}/e2e/login-as/1`);
    const a1 = await waitFor(async () => {
      const r = await recorder(alice);
      return r?.states.includes('connected') && r.presence.length > 0 ? r : null;
    }, 'Alice connected + presence sync');
    // realtime.js starts connecting while the module loads, before the recorder attaches.
    assert.deepEqual(a1.states.slice(-2), ['authenticating', 'connected']);
    assert.deepEqual(a1.presence[0], { action: 'sync', member: null, names: ['Alice'] });
    ok('Alice connected via Laravel-issued token; online = [Alice]');

    step('Bob logs in (separate browser context)');
    const bob = await cdp.newPage('bob');
    await bob.goto(`${LARAVEL}/e2e/login-as/2`);
    const b1 = await waitFor(async () => {
      const r = await recorder(bob);
      return r?.presence.find((p) => p.action === 'sync') ? r : null;
    }, 'Bob presence sync');
    assert.deepEqual(b1.presence.find((p) => p.action === 'sync').names, ['Alice', 'Bob']);
    await waitFor(async () => (await recorder(alice)).presence.some((p) => p.action === 'member_added' && p.member === '2'), 'Alice sees Bob join');
    const aliceList = await waitFor(async () => {
      const text = await alice.eval("document.getElementById('online').textContent");
      return text.includes('Bob') ? text : null;
    }, 'online list rendered in DOM');
    ok(`Alice got member_added(Bob); DOM list shows "${aliceList}"`);

    step('Laravel asks DynamicSocket who is online (DynamicSocketClient::presence)');
    const online = await alice.eval(`fetch('/online', { headers: { Accept: 'application/json' } }).then((r) => r.json())`);
    assert.deepEqual(online.users, { 1: true, 2: true, 3: false });
    assert.deepEqual(online.channel.members.map((m) => m.info.name).sort(), ['Alice', 'Bob']);
    ok(`users = ${JSON.stringify(online.users)}, members = ${online.channel.count}`);

    step('Alice places an order: DB transaction -> afterCommit queued job -> signed publish -> browser');
    const order = await alice.eval(csrfFetch('/orders', 'POST', { product_id: 1, quantity: 2 }));
    assert.equal(order.status, 201, order.body);
    const orderId = JSON.parse(order.body).id;
    const ev = await waitFor(async () => (await recorder(alice)).events.find((e) => e.event === 'order.created'), 'order.created in Alice\'s browser', 15_000);
    assert.equal(ev.channel, 'user.1');
    assert.equal(ev.id, `order.${orderId}.created`);
    assert.deepEqual(ev.data, { order_id: orderId, status: 'pending' });
    await sleep(300);
    assert.equal((await recorder(bob)).events.length, 0, 'Bob must not receive Alice\'s private event');
    ok(`Alice received order.created on user.1 (id ${ev.id}); Bob received nothing`);

    step('Bob reloads the page: no offline flicker for Alice (leave grace period)');
    await bob.goto(`${LARAVEL}/dashboard`);
    await waitFor(async () => (await recorder(bob))?.states.includes('connected'), 'Bob reconnected after reload');
    await sleep(GRACE_MS + 500);
    const afterReload = (await recorder(alice)).presence.filter((p) => p.member === '2');
    assert.deepEqual(afterReload.map((p) => p.action), ['member_added']);
    ok('no member_removed / member_added pair during reload');

    step('Bob logs out: Laravel Logout listener -> /v1/disconnect -> socket closed 4010 -> Alice sees Bob offline');
    const logout = await bob.eval(csrfFetch('/logout'));
    assert.equal(logout.status, 204, logout.body);
    await waitFor(async () => (await recorder(bob)).closes.includes(4010), 'Bob closed with 4010');
    const bobState = await bob.eval('window.realtime.state');
    assert.equal(bobState, 'disconnected');
    await waitFor(async () => (await recorder(alice)).presence.some((p) => p.action === 'member_removed' && p.member === '2'), 'Alice sees Bob leave', GRACE_MS + 5000);
    assert.deepEqual((await recorder(alice)).presence.at(-1).names, ['Alice']);
    const tokenAfterLogout = await bob.eval(`fetch('/dynamicsocket/token', { method: 'POST', headers: { Accept: 'application/json' } }).then((r) => r.status)`);
    assert.ok([401, 419].includes(tokenAfterLogout), `token endpoint after logout returned ${tokenAfterLogout}`);
    ok(`Bob disconnected (4010, SDK state "${bobState}"), Alice saw member_removed, token endpoint now ${tokenAfterLogout}`);

    step('Alice closes her tab: DynamicSocket reports her offline');
    await alice.close();
    await waitFor(async () => (await dsPresence({ users: ['1', '2'] })).users['1'] === false, 'Alice offline');
    await waitFor(async () => (await dsPresence({ channel: 'online' })).channel.count === 0, 'online channel empty', GRACE_MS + 5000);
    ok('users {1:false, 2:false}; online channel empty');

    const pageErrors = [...alice.errors, ...bob.errors];
    assert.deepEqual(pageErrors, [], `browser console errors: ${pageErrors.join(' | ')}`);
    ok('no JavaScript errors in either page');

    const dsLog = children[0].output;
    assert.ok(!dsLog.includes(SECRET), 'secret leaked to DynamicSocket log');
    assert.ok(!/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\./.test(dsLog), 'token leaked to DynamicSocket log');
    ok('no secrets or tokens in DynamicSocket logs');

    process.stdout.write('\nE2E PASSED\n');
  } finally {
    cdp.ws.close();
    chrome.kill('SIGTERM');
    await new Promise((r) => (chrome.exitCode !== null ? r() : chrome.once('exit', r)));
    try {
      rmSync(profile, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      /* best effort */
    }
  }
}

let exitCode = 0;
try {
  await main();
} catch (err) {
  exitCode = 1;
  process.stdout.write(`\nE2E FAILED: ${err.stack}\n`);
  for (const c of children) process.stdout.write(`\n----- ${c.name} output (tail) -----\n${c.output.slice(-3000)}\n`);
} finally {
  for (const c of children) c.kill('SIGTERM');
  await sleep(300);
  process.exit(exitCode);
}
