#!/usr/bin/env node
// Development helper: sends a signed POST /v1/publish (or /v1/disconnect)
// request using the locally configured secret.
import { signRequest } from '../src/auth/request-signature.js';
import { findApp, loadLocalConfig, parseArgs } from './lib.js';

const { values } = parseArgs({
  options: {
    url: { type: 'string', default: 'http://127.0.0.1:6001' },
    app: { type: 'string' },
    channel: { type: 'string', multiple: true, default: [] },
    user: { type: 'string', multiple: true, default: [] },
    event: { type: 'string' },
    data: { type: 'string', default: 'null' },
    disconnect: { type: 'boolean', default: false },
  },
});
if (!values.app || (!values.disconnect && !values.event)) {
  process.stderr.write(
    'Usage: npm run publish:signed -- --app <id> --event <name> [--channel c]... [--user u]... [--data JSON] [--url http://host:port]\n' +
      '       npm run publish:signed -- --app <id> --disconnect --user <id>...\n',
  );
  process.exit(1);
}
const config = loadLocalConfig();
const app = findApp(config, values.app);
const key = app.keys[0];

const path = values.disconnect ? '/v1/disconnect' : '/v1/publish';
const payload = values.disconnect
  ? { users: values.user }
  : { channels: values.channel, users: values.user, event: values.event, data: JSON.parse(values.data) };
const body = JSON.stringify(payload);
const headers = signRequest({ method: 'POST', path, body, appId: app.id, keyId: key.id, secret: key.secret });

const res = await fetch(new URL(path, values.url), {
  method: 'POST',
  headers: { ...headers, 'Content-Type': 'application/json' },
  body,
});
process.stdout.write(`${res.status} ${await res.text()}\n`);
process.exit(res.ok ? 0 : 1);
