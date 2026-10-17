import WebSocket from 'ws';
import { loadConfig } from '../../src/config/index.js';
import { createDynamicSocket } from '../../src/dynamicsocket.js';
import { createClientToken } from '../../src/auth/client-token.js';
import { signRequest } from '../../src/auth/request-signature.js';
import { createLogger } from '../../src/observability/logger.js';

export const SECRETS = {
  shop: { k1: 'shop-secret-k1-0123456789abcdef0123456789', k2: 'shop-secret-k2-0123456789abcdef0123456789' },
  parking: { p1: 'parking-secret-p1-0123456789abcdef01234567' },
};
export const ORIGIN = 'http://localhost:8000';

export const DEFAULT_APPS = [
  {
    id: 'shop',
    keys: [
      { id: 'k1', secret: SECRETS.shop.k1 },
      { id: 'k2', secret: SECRETS.shop.k2 },
    ],
    allowedOrigins: [ORIGIN],
    publicChannels: ['announcements', 'status.*', 'online'],
    presenceChannels: ['online', 'presence.*'],
  },
  {
    id: 'parking',
    keys: [{ id: 'p1', secret: SECRETS.parking.p1 }],
    allowedOrigins: ['http://parking.test'],
    allowMissingOrigin: true,
    publicChannels: [],
  },
];

/**
 * Starts a real DynamicSocket on an ephemeral port.
 * @param {Record<string,string>} [env] extra environment overrides
 * @param {{ apps?: object[] }} [opts]
 */
export async function startServer(env = {}, opts = {}) {
  const logs = [];
  const config = loadConfig({
    DS_HOST: '127.0.0.1',
    DS_PORT: '0',
    DS_APPS_JSON: JSON.stringify(opts.apps ?? DEFAULT_APPS),
    DS_HEARTBEAT_INTERVAL_MS: '60000',
    DS_SHUTDOWN_TIMEOUT_MS: '2000',
    ...env,
  });
  const logger = createLogger({ level: 'debug', write: (line) => logs.push(line) });
  const server = createDynamicSocket(config, { logger });
  const { port } = await server.start();
  const base = `http://127.0.0.1:${port}`;

  return {
    server,
    config,
    logs,
    port,
    base,
    wsUrl: (app = 'shop') => `ws://127.0.0.1:${port}${config.wsPath}?app=${encodeURIComponent(app)}`,
    stop: () => server.stop(),

    token(claims = {}, { app = 'shop', key = app === 'shop' ? 'k1' : 'p1', ttlSeconds = 300, now } = {}) {
      return createClientToken({
        appId: app,
        sub: '42',
        channels: ['orders', 'user.42', 'chat.room.*'],
        ttlSeconds,
        keyId: key,
        secret: SECRETS[app][key],
        now,
        ...claims,
      });
    },

    /** Sends a signed request. `body` may be an object or a raw string. */
    async signed(path, body, { app = 'shop', key, secret, now, nonce, headers = {}, method = 'POST' } = {}) {
      const keyId = key ?? (app === 'shop' ? 'k1' : 'p1');
      const raw = typeof body === 'string' ? body : JSON.stringify(body);
      const sig = signRequest({ method, path, body: raw, appId: app, keyId, secret: secret ?? SECRETS[app]?.[keyId] ?? 'x'.repeat(32), now, nonce });
      const res = await fetch(base + path, {
        method,
        headers: { 'Content-Type': 'application/json', ...sig, ...headers },
        body: raw,
      });
      const text = await res.text();
      let json;
      try {
        json = JSON.parse(text);
      } catch {
        json = undefined;
      }
      return { status: res.status, body: json, text, headers: res.headers, sig };
    },

    publish(payload, opts) {
      return this.signed('/v1/publish', payload, opts);
    },

    async connect({ app = 'shop', origin = app === 'shop' ? ORIGIN : 'http://parking.test', wsOptions = {} } = {}) {
      const client = new TestClient(this.wsUrl(app), { origin, ...wsOptions });
      await client.opened;
      await client.next((m) => m.type === 'hello');
      return client;
    },

    /** Connects and authenticates; returns the client. */
    async authed(claims = {}, opts = {}) {
      const client = await this.connect(opts);
      client.send({ type: 'auth', token: this.token(claims, opts) });
      const reply = await client.next((m) => m.type === 'auth_ok' || m.type === 'error');
      if (reply.type !== 'auth_ok') throw new Error(`auth failed: ${JSON.stringify(reply)}`);
      return client;
    },
  };
}

/** WebSocket client that buffers messages so tests can await them. */
export class TestClient {
  constructor(url, options = {}) {
    this.ws = new WebSocket(url, options);
    this.messages = [];
    this.waiters = [];
    this.closed = new Promise((resolve) => {
      this.ws.on('close', (code, reason) => resolve({ code, reason: reason.toString() }));
    });
    this.opened = new Promise((resolve, reject) => {
      this.ws.once('open', resolve);
      this.ws.once('error', reject);
      this.ws.once('unexpected-response', (_req, res) => reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode })));
    });
    this.ws.on('error', () => {});
    this.ws.on('message', (data) => {
      const msg = JSON.parse(data.toString());
      this.messages.push(msg);
      this.flush();
    });
  }

  flush() {
    for (const waiter of [...this.waiters]) {
      const index = this.messages.findIndex(waiter.predicate);
      if (index !== -1) {
        const [msg] = this.messages.splice(index, 1);
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        clearTimeout(waiter.timer);
        waiter.resolve(msg);
      }
    }
  }

  send(obj) {
    this.ws.send(typeof obj === 'string' ? obj : JSON.stringify(obj));
  }

  /** Resolves with the first (buffered or future) message matching predicate. */
  next(predicate = () => true, timeoutMs = 2000) {
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve };
      waiter.timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        reject(new Error(`timeout waiting for message; buffered: ${JSON.stringify(this.messages)}`));
      }, timeoutMs);
      this.waiters.push(waiter);
      this.flush();
    });
  }

  /** Asserts that no matching message arrives within `ms`. */
  async none(predicate = () => true, ms = 150) {
    await new Promise((r) => setTimeout(r, ms));
    const found = this.messages.find(predicate);
    if (found) throw new Error(`unexpected message: ${JSON.stringify(found)}`);
  }

  async subscribe(channel) {
    this.send({ type: 'subscribe', channel });
    return this.next((m) => (m.type === 'subscribed' || m.type === 'error') && m.channel === channel);
  }

  close() {
    this.ws.close();
    return this.closed;
  }
}

export const delay = (ms) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(fn, timeoutMs = 2000, stepMs = 10) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await fn()) return;
    await delay(stepMs);
  }
  throw new Error('waitFor timed out');
}
