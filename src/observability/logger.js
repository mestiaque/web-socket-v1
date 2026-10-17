/**
 * Structured JSON-lines logger with recursive redaction.
 *
 * Any field whose key looks sensitive is replaced with "[REDACTED]" before
 * serialization, and long strings are truncated. Callers should still avoid
 * passing secrets; redaction is a safety net, not a licence.
 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, silent: 100 };

const SENSITIVE_KEY = /(token|secret|password|passwd|signature|authorization|cookie|api[-_]?key|credential|private[-_]?key)/i;
const MAX_STRING = 512;
const MAX_DEPTH = 6;

export function redact(value, depth = 0) {
  if (depth > MAX_DEPTH) return '[TRUNCATED]';
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return value.length > MAX_STRING ? `${value.slice(0, MAX_STRING)}…[truncated]` : value;
  if (typeof value !== 'object') return value;
  if (Buffer.isBuffer(value)) return `[Buffer ${value.length} bytes]`;
  if (value instanceof Error) {
    const out = { name: value.name, message: redact(value.message, depth + 1) };
    if (value.code) out.code = value.code;
    if (value.stack) out.stack = value.stack;
    return out;
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));
  const out = {};
  for (const [key, v] of Object.entries(value)) {
    out[key] = SENSITIVE_KEY.test(key) ? '[REDACTED]' : redact(v, depth + 1);
  }
  return out;
}

/**
 * @param {{ level?: string, write?: (line: string) => void, base?: object }} [opts]
 */
export function createLogger(opts = {}) {
  const threshold = LEVELS[opts.level ?? 'info'] ?? LEVELS.info;
  const write = opts.write ?? ((line) => process.stdout.write(line + '\n'));
  const base = opts.base ?? {};

  const log = (level, msg, fields) => {
    if (LEVELS[level] < threshold) return;
    const entry = { time: new Date().toISOString(), level, msg, ...base, ...(fields ? redact(fields) : {}) };
    let line;
    try {
      line = JSON.stringify(entry);
    } catch {
      line = JSON.stringify({ time: entry.time, level, msg, note: 'unserializable log fields' });
    }
    write(line);
  };

  return {
    debug: (msg, fields) => log('debug', msg, fields),
    info: (msg, fields) => log('info', msg, fields),
    warn: (msg, fields) => log('warn', msg, fields),
    error: (msg, fields) => log('error', msg, fields),
    child: (extra) => createLogger({ level: opts.level, write, base: { ...base, ...extra } }),
  };
}
