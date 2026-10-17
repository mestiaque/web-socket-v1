#!/usr/bin/env node
/**
 * Reproducible load test against a RUNNING DynamicSocket server.
 * See docs/LOADTEST.md for the plan and how to interpret results.
 *
 *   npm run loadtest -- --app shop --clients 500 --rate 50 --size 512 --duration 30
 *
 * Uses the local .env / apps configuration to mint client tokens and sign
 * publish requests, so run it only against environments you control.
 * All clients connect from this machine: raise DS_MAX_CONNECTIONS_PER_IP and
 * DS_UPGRADES_PER_IP_PER_MIN on the server accordingly.
 */
import { performance } from 'node:perf_hooks';
import WebSocket from 'ws';
import { createClientToken } from '../src/auth/client-token.js';
import { signRequest } from '../src/auth/request-signature.js';
import { findApp, loadLocalConfig, parseArgs } from './lib.js';

const { values } = parseArgs({
  options: {
    url: { type: 'string', default: 'http://127.0.0.1:6001' },
    'ws-url': { type: 'string' },
    app: { type: 'string' },
    origin: { type: 'string' },
    clients: { type: 'string', default: '100' },
    channels: { type: 'string', default: '1' },
    rate: { type: 'string', default: '10' },
    size: { type: 'string', default: '256' },
    duration: { type: 'string', default: '10' },
    'connect-concurrency': { type: 'string', default: '50' },
  },
});
if (!values.app) {
  process.stderr.write('Usage: npm run loadtest -- --app <id> [--clients 100] [--channels 1] [--rate 10] [--size 256] [--duration 10] [--url http://127.0.0.1:6001]\n');
  process.exit(1);
}

const config = loadLocalConfig();
const app = findApp(config, values.app);
const key = app.keys[0];
const clients = Number(values.clients);
const channelCount = Number(values.channels);
const rate = Number(values.rate);
const size = Number(values.size);
const durationMs = Number(values.duration) * 1000;
const httpUrl = values.url.replace(/\/$/, '');
const wsUrl = values['ws-url'] ?? `${httpUrl.replace(/^http/, 'ws')}${config.wsPath}`;
const origin = values.origin ?? app.allowedOrigins.find((o) => o !== '*');

const channels = Array.from({ length: channelCount }, (_, i) => `loadtest.${i}`);
const stats = { connectMs: [], connectFailures: 0, authFailures: 0, received: 0, latencyMs: [], publishMs: [], publishErrors: 0, expected: 0, closes: {} };

function percentile(list, p) {
  if (list.length === 0) return null;
  const sorted = [...list].sort((a, b) => a - b);
  return Number(sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))].toFixed(2));
}

function openClient(i) {
  return new Promise((resolve) => {
    const started = performance.now();
    const ws = new WebSocket(`${wsUrl}?app=${encodeURIComponent(app.id)}`, origin ? { origin } : {});
    const channel = channels[i % channels.length];
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      resolve(ok ? ws : null);
    };
    ws.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'hello') {
        const token = createClientToken({ appId: app.id, sub: `load-${i}`, channels: [channel], ttlSeconds: 120, keyId: key.id, secret: key.secret });
        ws.send(JSON.stringify({ type: 'auth', token }));
      } else if (msg.type === 'auth_ok') {
        ws.send(JSON.stringify({ type: 'subscribe', channel }));
      } else if (msg.type === 'subscribed') {
        stats.connectMs.push(performance.now() - started);
        done(true);
      } else if (msg.type === 'event') {
        stats.received += 1;
        stats.latencyMs.push(Date.now() - msg.data.t);
      } else if (msg.type === 'error') {
        stats.authFailures += 1;
        done(false);
      }
    });
    ws.on('close', (code) => {
      stats.closes[code] = (stats.closes[code] ?? 0) + 1;
      done(false);
    });
    ws.on('error', () => {
      stats.connectFailures += 1;
      done(false);
    });
  });
}

async function publish(channel, padding) {
  const body = JSON.stringify({ channel, event: 'loadtest.tick', data: { t: Date.now(), pad: padding } });
  const path = '/v1/publish';
  const headers = signRequest({ method: 'POST', path, body, appId: app.id, keyId: key.id, secret: key.secret });
  const started = performance.now();
  try {
    const res = await fetch(httpUrl + path, { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body });
    const json = await res.json();
    stats.publishMs.push(performance.now() - started);
    if (!res.ok) stats.publishErrors += 1;
    else stats.expected += json.delivery.sent;
  } catch {
    stats.publishErrors += 1;
  }
}

const sockets = [];
const connectStarted = performance.now();
const concurrency = Number(values['connect-concurrency']);
for (let i = 0; i < clients; i += concurrency) {
  const batch = await Promise.all(Array.from({ length: Math.min(concurrency, clients - i) }, (_, j) => openClient(i + j)));
  sockets.push(...batch.filter(Boolean));
}
const connectPhaseMs = performance.now() - connectStarted;
process.stderr.write(`connected ${sockets.length}/${clients} clients in ${connectPhaseMs.toFixed(0)} ms; publishing…\n`);

const padding = 'x'.repeat(Math.max(0, size - 60));
const intervalMs = 1000 / rate;
const pending = new Set();
const publishStarted = performance.now();
let n = 0;
while (performance.now() - publishStarted < durationMs) {
  const p = publish(channels[n % channels.length], padding);
  pending.add(p);
  p.finally(() => pending.delete(p));
  n += 1;
  const next = publishStarted + n * intervalMs;
  await new Promise((r) => setTimeout(r, Math.max(0, next - performance.now())));
}
await Promise.all(pending);
await new Promise((r) => setTimeout(r, 1000)); // allow in-flight frames to arrive

for (const ws of sockets) ws.close();

const report = {
  parameters: { clients, channels: channelCount, ratePerSecond: rate, messageBytes: size, durationSeconds: durationMs / 1000, wsUrl },
  connections: {
    established: sockets.length,
    failed: clients - sockets.length,
    connectPhaseMs: Math.round(connectPhaseMs),
    connectMs: { p50: percentile(stats.connectMs, 50), p95: percentile(stats.connectMs, 95), p99: percentile(stats.connectMs, 99) },
    closesDuringTest: stats.closes,
  },
  publishing: {
    requests: n,
    errors: stats.publishErrors,
    achievedRatePerSecond: Number((n / (durationMs / 1000)).toFixed(1)),
    httpLatencyMs: { p50: percentile(stats.publishMs, 50), p95: percentile(stats.publishMs, 95), p99: percentile(stats.publishMs, 99) },
  },
  delivery: {
    framesReportedSent: stats.expected,
    framesReceived: stats.received,
    endToEndLatencyMs: { p50: percentile(stats.latencyMs, 50), p95: percentile(stats.latencyMs, 95), p99: percentile(stats.latencyMs, 99), max: percentile(stats.latencyMs, 100) },
  },
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
process.exit(0);
