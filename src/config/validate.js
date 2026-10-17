/**
 * Small, dependency-free parsers for environment variables.
 * Every parser pushes human-readable problems onto `problems` instead of
 * throwing, so operators see all configuration errors at once.
 */

export function parseIntVar(env, name, def, { min = -Infinity, max = Infinity }, problems) {
  const raw = env[name];
  if (raw === undefined || raw === '') return def;
  if (!/^-?\d+$/.test(String(raw).trim())) {
    problems.push(`${name} must be an integer (got "${raw}")`);
    return def;
  }
  const value = Number.parseInt(raw, 10);
  if (value < min || value > max) {
    problems.push(`${name} must be between ${min} and ${max} (got ${value})`);
    return def;
  }
  return value;
}

export function parseBoolVar(env, name, def, problems) {
  const raw = env[name];
  if (raw === undefined || raw === '') return def;
  const v = String(raw).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(v)) return true;
  if (['0', 'false', 'no', 'off'].includes(v)) return false;
  problems.push(`${name} must be a boolean (true/false), got "${raw}"`);
  return def;
}

export function parseListVar(env, name, def = []) {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return def;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

export function parseEnumVar(env, name, def, allowed, problems) {
  const raw = env[name];
  if (raw === undefined || raw === '') return def;
  const v = raw.trim().toLowerCase();
  if (!allowed.includes(v)) {
    problems.push(`${name} must be one of ${allowed.join(', ')} (got "${raw}")`);
    return def;
  }
  return v;
}

export const APP_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
export const KEY_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
export const MIN_SECRET_LENGTH = 32;

/**
 * Normalizes an allowed-origin entry. Returns null when invalid.
 * Only scheme://host[:port] is accepted; paths are rejected so that operators
 * do not mistakenly believe path-level restrictions apply.
 */
export function normalizeOrigin(entry) {
  if (entry === '*') return '*';
  try {
    const url = new URL(entry);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.pathname !== '/' || url.search || url.hash || url.username || url.password) return null;
    if (entry.endsWith('/')) return null;
    return url.origin;
  } catch {
    return null;
  }
}
