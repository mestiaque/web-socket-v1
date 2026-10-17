#!/usr/bin/env node
/**
 * DEVELOPMENT-ONLY stand-in for your application backend (e.g. Laravel).
 *
 * Serves the demo page and the SDK, issues client tokens for a fixed demo
 * user, and publishes demo events through the signed HTTP API. It has no
 * authentication of its own, binds to 127.0.0.1 and refuses to start when
 * NODE_ENV=production. Never deploy it.
 *
 *   node examples/browser/dev-backend.js --app shop --port 8080
 *   (add http://localhost:8080 to the app's allowedOrigins)
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createClientToken } from '../../src/auth/client-token.js';
import { signRequest } from '../../src/auth/request-signature.js';
import { findApp, loadLocalConfig, parseArgs } from '../../scripts/lib.js';

if (process.env.NODE_ENV === 'production') {
  process.stderr.write('dev-backend.js is for local development only.\n');
  process.exit(1);
}

const { values } = parseArgs({
  options: {
    app: { type: 'string', default: 'shop' },
    port: { type: 'string', default: '8080' },
    server: { type: 'string', default: 'http://127.0.0.1:6001' },
  },
});
const config = loadLocalConfig();
const app = findApp(config, values.app);
const key = app.keys[0];
const DEMO_USER = 'demo-user';
const files = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/sdk/dynamicsocket.js': ['../../sdk/dynamicsocket.js', 'text/javascript; charset=utf-8'],
};

async function readJson(req) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > 16_384) throw new Error('too large');
  }
  return raw ? JSON.parse(raw) : {};
}

createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && files[req.url]) {
      const [file, type] = files[req.url];
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
      res.end(await readFile(fileURLToPath(new URL(file, import.meta.url))));
      return;
    }
    if (req.method === 'GET' && req.url === '/config') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ url: `${values.server.replace(/^http/, 'ws')}${config.wsPath}`, appId: app.id, user: DEMO_USER }));
      return;
    }
    if (req.method === 'POST' && req.url === '/token') {
      const token = createClientToken({
        appId: app.id,
        sub: DEMO_USER,
        channels: ['demo.*', `user.${DEMO_USER}`],
        ttlSeconds: 120,
        keyId: key.id,
        secret: key.secret,
      });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ token }));
      return;
    }
    if (req.method === 'POST' && req.url === '/publish') {
      const input = await readJson(req);
      const body = JSON.stringify({ channel: String(input.channel), event: String(input.event), data: input.data ?? null });
      const headers = signRequest({ method: 'POST', path: '/v1/publish', body, appId: app.id, keyId: key.id, secret: key.secret });
      const upstream = await fetch(`${values.server}/v1/publish`, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body });
      res.writeHead(upstream.status, { 'Content-Type': 'application/json' });
      res.end(await upstream.text());
      return;
    }
    res.writeHead(404).end();
  } catch {
    res.writeHead(400).end();
  }
}).listen(Number(values.port), '127.0.0.1', () => {
  process.stdout.write(`Demo: http://localhost:${values.port}  (app "${app.id}", DynamicSocket ${values.server})\n`);
});
