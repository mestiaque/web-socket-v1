#!/usr/bin/env node
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from './config/index.js';
import { createDynamicSocket } from './dynamicsocket.js';
import { createLogger } from './observability/logger.js';
import { ConfigError } from './utils/errors.js';
import { instanceId } from './utils/ids.js';

// Load .env (or DS_ENV_FILE) if present. Variables already set in the real
// environment take precedence over the file.
const envFile = resolve(process.env.DS_ENV_FILE ?? '.env');
if (existsSync(envFile)) process.loadEnvFile(envFile);

let config;
try {
  config = loadConfig(process.env);
} catch (err) {
  if (err instanceof ConfigError) {
    process.stderr.write(`${err.message}\n`);
    process.exit(78); // EX_CONFIG
  }
  throw err;
}

const logger = createLogger({ level: config.logLevel, base: { instanceId } });
const server = createDynamicSocket(config, { logger });

let stopping = false;
async function shutdown(signal) {
  if (stopping) return;
  stopping = true;
  logger.info('signal received', { signal });
  const hardExit = setTimeout(() => process.exit(1), config.timeouts.shutdownTimeoutMs + 5000);
  hardExit.unref();
  try {
    await server.stop();
    process.exit(0);
  } catch (err) {
    logger.error('error during shutdown', { err });
    process.exit(1);
  }
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('unhandledRejection', (reason) => logger.error('unhandled rejection', { err: reason }));
process.on('uncaughtException', (err) => {
  logger.error('uncaught exception; exiting', { err });
  process.exit(1);
});

server.start().catch((err) => {
  logger.error('failed to start', { err });
  process.exit(1);
});
