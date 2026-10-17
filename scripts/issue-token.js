#!/usr/bin/env node
// Development helper: issues a client token using the locally configured
// secret. In production, tokens are issued by your application backend.
import { createClientToken } from '../src/auth/client-token.js';
import { findApp, loadLocalConfig, parseArgs } from './lib.js';

const { values } = parseArgs({
  options: {
    app: { type: 'string' },
    sub: { type: 'string' },
    channels: { type: 'string', default: '' },
    ttl: { type: 'string', default: '300' },
    key: { type: 'string' },
  },
});
if (!values.app || !values.sub) {
  process.stderr.write('Usage: npm run token:issue -- --app <id> --sub <user> [--channels a,b.*] [--ttl 300] [--key <kid>]\n');
  process.exit(1);
}
const config = loadLocalConfig();
const app = findApp(config, values.app);
const key = values.key ? app.keys.find((k) => k.id === values.key) : app.keys[0];
if (!key) {
  process.stderr.write(`Unknown key "${values.key}"\n`);
  process.exit(1);
}
const token = createClientToken({
  appId: app.id,
  sub: values.sub,
  channels: values.channels.split(',').map((s) => s.trim()).filter(Boolean),
  ttlSeconds: Number(values.ttl),
  keyId: key.id,
  secret: key.secret,
});
process.stdout.write(`${token}\n`);
