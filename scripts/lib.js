import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { loadConfig } from '../src/config/index.js';

/** Loads .env and the server configuration, exactly as the server does. */
export function loadLocalConfig() {
  const envFile = resolve(process.env.DS_ENV_FILE ?? '.env');
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  return loadConfig(process.env);
}

export function findApp(config, appId) {
  const app = config.apps.find((a) => a.id === appId);
  if (!app) {
    process.stderr.write(`Unknown app "${appId}". Configured: ${config.apps.map((a) => a.id).join(', ')}\n`);
    process.exit(1);
  }
  return app;
}

export { parseArgs };
