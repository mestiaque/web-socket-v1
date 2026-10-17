#!/usr/bin/env node
// Prints a new random signing secret and an apps.json entry for it.
// The secret is printed once to stdout; store it in a secret manager or
// environment variable, never in browser code or version control.
import { randomBytes } from 'node:crypto';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    id: { type: 'string', default: 'myapp' },
    key: { type: 'string', default: new Date().toISOString().slice(0, 7) },
    origin: { type: 'string', multiple: true, default: [] },
  },
});

const secret = randomBytes(32).toString('base64url');
const envName = `DS_${values.id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_SECRET_${values.key.toUpperCase().replace(/[^A-Z0-9]/g, '_')}`;
const entry = {
  id: values.id,
  keys: [{ id: values.key, secretEnv: envName }],
  allowedOrigins: values.origin,
  allowMissingOrigin: false,
  publicChannels: [],
};

process.stdout.write(`# Add to the DynamicSocket environment (and to the Laravel .env as DYNAMICSOCKET_SECRET):\n${envName}=${secret}\n\n`);
process.stdout.write(`# apps.json entry:\n${JSON.stringify(entry, null, 2)}\n`);
