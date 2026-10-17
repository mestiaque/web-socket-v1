/**
 * WebSocket Origin policy, evaluated during the HTTP upgrade.
 *
 * Browsers always send Origin on WebSocket handshakes and scripts cannot
 * forge it, so an allowlist stops other websites from opening sockets with a
 * victim's ambient credentials. Non-browser clients can send any Origin or
 * none at all, so this check is NOT authentication: every connection must
 * still present a valid signed token.
 *
 * Policy:
 *  - Origin present  -> must exactly match an entry in app.allowedOrigins
 *                       (or the app lists "*", which disables the check).
 *  - Origin missing  -> allowed only if app.allowMissingOrigin is true
 *                       (intended for trusted server-side/native clients).
 *  - Origin "null"   -> treated as a present, non-matching origin.
 *
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function checkOrigin(app, originHeader) {
  if (originHeader === undefined || originHeader === '') {
    return app.allowMissingOrigin ? { ok: true } : { ok: false, reason: 'origin_missing' };
  }
  if (app.allowedOrigins.includes('*')) return { ok: true };
  let normalized;
  try {
    normalized = new URL(originHeader).origin;
  } catch {
    return { ok: false, reason: 'origin_invalid' };
  }
  // Browsers send the canonical serialization (scheme://host[:port]); anything
  // else (paths, opaque "null"-like origins, odd casing) is rejected.
  if (normalized === 'null' || normalized !== originHeader) return { ok: false, reason: 'origin_invalid' };
  return app.allowedOrigins.includes(normalized) ? { ok: true } : { ok: false, reason: 'origin_not_allowed' };
}
