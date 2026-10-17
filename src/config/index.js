import { readFileSync } from 'node:fs';
import { isIP } from 'node:net';
import { resolve } from 'node:path';
import { ConfigError } from '../utils/errors.js';
import { normalizeIp } from '../utils/client-ip.js';
import { isValidChannelPattern } from '../channels/channel-names.js';
import {
  APP_ID_PATTERN,
  KEY_ID_PATTERN,
  MIN_SECRET_LENGTH,
  normalizeOrigin,
  parseBoolVar,
  parseEnumVar,
  parseIntVar,
  parseListVar,
} from './validate.js';

const LOG_LEVELS = ['debug', 'info', 'warn', 'error', 'silent'];

/**
 * Builds the immutable runtime configuration from environment variables.
 * Throws ConfigError listing every problem found.
 *
 * @param {Record<string, string|undefined>} env
 * @param {{ cwd?: string }} [opts]
 */
export function loadConfig(env = process.env, opts = {}) {
  const problems = [];
  const cwd = opts.cwd ?? process.cwd();
  const int = (name, def, range) => parseIntVar(env, name, def, range, problems);
  const bool = (name, def) => parseBoolVar(env, name, def, problems);

  // DS_PORT wins; PORT is honoured because some process managers (including
  // Passenger-based cPanel setups) assign it.
  const portVar = env.DS_PORT !== undefined && env.DS_PORT !== '' ? 'DS_PORT' : 'PORT';

  const config = {
    host: env.DS_HOST?.trim() || '127.0.0.1',
    port: parseIntVar(env, portVar, 6001, { min: 0, max: 65535 }, problems),
    wsPath: env.DS_WS_PATH?.trim() || '/ws',
    logLevel: parseEnumVar(env, 'DS_LOG_LEVEL', 'info', LOG_LEVELS, problems),
    trustedProxies: [],
    metricsToken: env.DS_METRICS_TOKEN || null,

    limits: {
      maxConnections: int('DS_MAX_CONNECTIONS', 10000, { min: 1, max: 1_000_000 }),
      maxConnectionsPerIp: int('DS_MAX_CONNECTIONS_PER_IP', 100, { min: 1, max: 1_000_000 }),
      maxPayloadBytes: int('DS_MAX_PAYLOAD_BYTES', 16 * 1024, { min: 512, max: 1024 * 1024 }),
      maxPublishBodyBytes: int('DS_MAX_PUBLISH_BODY_BYTES', 64 * 1024, { min: 1024, max: 10 * 1024 * 1024 }),
      maxSubscriptionsPerConnection: int('DS_MAX_SUBSCRIPTIONS_PER_CONNECTION', 100, { min: 1, max: 10000 }),
      maxBufferedBytes: int('DS_MAX_BUFFERED_BYTES', 1024 * 1024, { min: 16 * 1024, max: 256 * 1024 * 1024 }),
      maxPublishTargets: int('DS_MAX_PUBLISH_TARGETS', 100, { min: 1, max: 10000 }),
      maxPresenceMembers: int('DS_PRESENCE_MAX_MEMBERS', 1000, { min: 1, max: 100_000 }),
    },

    timeouts: {
      authTimeoutMs: int('DS_AUTH_TIMEOUT_MS', 10_000, { min: 100, max: 120_000 }),
      heartbeatIntervalMs: int('DS_HEARTBEAT_INTERVAL_MS', 30_000, { min: 50, max: 600_000 }),
      shutdownTimeoutMs: int('DS_SHUTDOWN_TIMEOUT_MS', 10_000, { min: 0, max: 600_000 }),
      httpRequestTimeoutMs: int('DS_HTTP_REQUEST_TIMEOUT_MS', 10_000, { min: 1000, max: 300_000 }),
      httpHeadersTimeoutMs: int('DS_HTTP_HEADERS_TIMEOUT_MS', 5_000, { min: 1000, max: 120_000 }),
      httpKeepAliveTimeoutMs: int('DS_HTTP_KEEPALIVE_TIMEOUT_MS', 5_000, { min: 0, max: 120_000 }),
      slowConsumerGraceMs: int('DS_SLOW_CONSUMER_GRACE_MS', 2_000, { min: 0, max: 60_000 }),
      presenceLeaveGraceMs: int('DS_PRESENCE_LEAVE_GRACE_MS', 3_000, { min: 0, max: 60_000 }),
    },

    tokens: {
      maxTtlSeconds: int('DS_TOKEN_MAX_TTL_SECONDS', 900, { min: 10, max: 86_400 }),
      clockSkewSeconds: int('DS_TOKEN_CLOCK_SKEW_SECONDS', 30, { min: 0, max: 300 }),
      singleUse: bool('DS_TOKEN_SINGLE_USE', true),
      maxSessionSeconds: int('DS_MAX_SESSION_SECONDS', 3600, { min: 0, max: 7 * 86_400 }),
    },

    signatures: {
      toleranceSeconds: int('DS_SIGNATURE_TOLERANCE_SECONDS', 300, { min: 5, max: 3600 }),
      nonceStoreMax: int('DS_NONCE_STORE_MAX', 100_000, { min: 100, max: 10_000_000 }),
    },

    rateLimits: {
      clientMessagesPerSecond: int('DS_CLIENT_RATE_PER_SEC', 10, { min: 1, max: 100_000 }),
      clientMessagesBurst: int('DS_CLIENT_RATE_BURST', 20, { min: 1, max: 100_000 }),
      clientViolationsBeforeClose: int('DS_CLIENT_RATE_VIOLATIONS_BEFORE_CLOSE', 5, { min: 1, max: 1000 }),
      publishPerSecond: int('DS_PUBLISH_RATE_PER_SEC', 100, { min: 1, max: 1_000_000 }),
      publishBurst: int('DS_PUBLISH_RATE_BURST', 200, { min: 1, max: 1_000_000 }),
      upgradesPerIpPerMinute: int('DS_UPGRADES_PER_IP_PER_MIN', 120, { min: 1, max: 1_000_000 }),
      authFailuresPerIpPerMinute: int('DS_AUTH_FAILURES_PER_IP_PER_MIN', 30, { min: 1, max: 1_000_000 }),
    },

    apps: [],
  };

  if (!config.wsPath.startsWith('/')) problems.push('DS_WS_PATH must start with "/"');

  for (const entry of parseListVar(env, 'DS_TRUSTED_PROXIES')) {
    const ip = normalizeIp(entry);
    if (!isIP(ip)) problems.push(`DS_TRUSTED_PROXIES contains an invalid IP address: "${entry}"`);
    else config.trustedProxies.push(ip);
  }

  if (config.metricsToken !== null && config.metricsToken.length < 16) {
    problems.push('DS_METRICS_TOKEN must be at least 16 characters when set');
  }

  config.apps = loadApps(env, cwd, config, problems);

  if (problems.length > 0) throw new ConfigError(problems);
  return deepFreeze(config);
}

function loadApps(env, cwd, config, problems) {
  let raw;
  let source;
  if (env.DS_APPS_JSON && env.DS_APPS_JSON.trim() !== '') {
    raw = env.DS_APPS_JSON;
    source = 'DS_APPS_JSON';
  } else if (env.DS_APPS_FILE && env.DS_APPS_FILE.trim() !== '') {
    const file = resolve(cwd, env.DS_APPS_FILE.trim());
    source = `DS_APPS_FILE (${file})`;
    try {
      raw = readFileSync(file, 'utf8');
    } catch (err) {
      problems.push(`${source} could not be read: ${err.code ?? err.message}`);
      return [];
    }
  } else {
    problems.push('No applications configured: set DS_APPS_FILE or DS_APPS_JSON');
    return [];
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // Do not echo the content: it contains secrets.
    problems.push(`${source} is not valid JSON`);
    return [];
  }
  const list = Array.isArray(parsed) ? parsed : parsed?.apps;
  if (!Array.isArray(list) || list.length === 0) {
    problems.push(`${source} must be a non-empty array of applications (or {"apps": [...]})`);
    return [];
  }

  const seen = new Set();
  const apps = [];
  list.forEach((app, i) => {
    const where = `app[${i}]`;
    if (typeof app !== 'object' || app === null) {
      problems.push(`${where} must be an object`);
      return;
    }
    if (typeof app.id !== 'string' || !APP_ID_PATTERN.test(app.id)) {
      problems.push(`${where}.id must match ${APP_ID_PATTERN}`);
      return;
    }
    if (seen.has(app.id)) problems.push(`${where}.id "${app.id}" is duplicated`);
    seen.add(app.id);
    const label = `app "${app.id}"`;

    const keys = [];
    if (!Array.isArray(app.keys) || app.keys.length === 0) {
      problems.push(`${label} must define at least one entry in "keys"`);
    } else {
      const kids = new Set();
      app.keys.forEach((key, k) => {
        if (typeof key?.id !== 'string' || !KEY_ID_PATTERN.test(key.id)) {
          problems.push(`${label} keys[${k}].id must match ${KEY_ID_PATTERN}`);
          return;
        }
        if (kids.has(key.id)) problems.push(`${label} key id "${key.id}" is duplicated`);
        kids.add(key.id);
        let secret = key.secret;
        if (key.secretEnv !== undefined) {
          if (typeof key.secretEnv !== 'string' || !env[key.secretEnv]) {
            problems.push(`${label} key "${key.id}" references secretEnv "${key.secretEnv}" which is not set`);
            return;
          }
          secret = env[key.secretEnv];
        }
        if (typeof secret !== 'string' || secret.length < MIN_SECRET_LENGTH) {
          problems.push(`${label} key "${key.id}" secret must be a string of at least ${MIN_SECRET_LENGTH} characters`);
          return;
        }
        keys.push({ id: key.id, secret: Buffer.from(secret, 'utf8') });
      });
    }

    const allowedOrigins = [];
    for (const origin of app.allowedOrigins ?? []) {
      const normalized = normalizeOrigin(origin);
      if (normalized === null) problems.push(`${label} allowedOrigins entry "${origin}" is not a valid origin (scheme://host[:port])`);
      else allowedOrigins.push(normalized);
    }

    const publicChannels = [];
    for (const pattern of app.publicChannels ?? []) {
      if (!isValidChannelPattern(pattern)) problems.push(`${label} publicChannels entry "${pattern}" is not a valid channel pattern`);
      else publicChannels.push(pattern);
    }

    const presenceChannels = [];
    for (const pattern of app.presenceChannels ?? []) {
      if (!isValidChannelPattern(pattern)) problems.push(`${label} presenceChannels entry "${pattern}" is not a valid channel pattern`);
      else presenceChannels.push(pattern);
    }

    const allowMissingOrigin = app.allowMissingOrigin ?? false;
    if (typeof allowMissingOrigin !== 'boolean') problems.push(`${label} allowMissingOrigin must be a boolean`);

    const maxConnections = app.maxConnections ?? config.limits.maxConnections;
    if (!Number.isInteger(maxConnections) || maxConnections < 1) problems.push(`${label} maxConnections must be a positive integer`);

    const publishRate = {
      perSecond: app.publishRate?.perSecond ?? config.rateLimits.publishPerSecond,
      burst: app.publishRate?.burst ?? config.rateLimits.publishBurst,
    };
    if (!Number.isInteger(publishRate.perSecond) || publishRate.perSecond < 1 || !Number.isInteger(publishRate.burst) || publishRate.burst < 1) {
      problems.push(`${label} publishRate.perSecond and publishRate.burst must be positive integers`);
    }

    apps.push({
      id: app.id,
      name: typeof app.name === 'string' ? app.name : app.id,
      keys,
      allowedOrigins,
      allowMissingOrigin,
      publicChannels,
      presenceChannels,
      maxConnections,
      publishRate,
    });
  });
  return apps;
}

function deepFreeze(obj) {
  if (obj && typeof obj === 'object' && !Buffer.isBuffer(obj) && !Object.isFrozen(obj)) {
    Object.freeze(obj);
    for (const value of Object.values(obj)) deepFreeze(value);
  }
  return obj;
}
