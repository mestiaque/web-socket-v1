import { DsError, ErrorCode } from '../utils/errors.js';
import { USER_ID_MAX_LENGTH } from '../messaging/event-validator.js';
import { CloseCode } from '../websocket/protocol.js';
import { sendJson } from './respond.js';
import { authenticateSignedRequest } from './signed-request.js';

/**
 * POST /v1/disconnect — signed request that closes every active connection
 * of the given users in the calling application (close code 4010).
 *
 * Use on logout, account suspension or permission changes. Combined with
 * short-lived single-use tokens this bounds how long a revoked user can stay
 * connected: existing sockets are closed now, and new sockets need a new
 * token from the backend.
 */
export async function handleDisconnect(req, res, ctx) {
  const { app, body } = await authenticateSignedRequest(req, ctx);
  const users = body?.users;
  if (!Array.isArray(users) || users.length === 0 || users.length > ctx.config.limits.maxPublishTargets) {
    throw new DsError(ErrorCode.BAD_MESSAGE, `"users" must be a non-empty array (max ${ctx.config.limits.maxPublishTargets})`, { status: 422 });
  }

  // Validate every id before closing anything, so a 422 has no side effects.
  const subs = users.map((raw) => {
    const sub = Number.isSafeInteger(raw) && raw >= 0 ? String(raw) : raw;
    if (typeof sub !== 'string' || sub.length === 0 || sub.length > USER_ID_MAX_LENGTH) {
      throw new DsError(ErrorCode.BAD_MESSAGE, 'Invalid user id', { status: 422 });
    }
    return sub;
  });

  let closed = 0;
  for (const sub of subs) {
    for (const conn of [...ctx.channels.registry.userConnections(app.id, sub)]) {
      conn.sendError(ErrorCode.FORBIDDEN, 'Disconnected by the application');
      conn.close(CloseCode.DISCONNECTED, 'disconnected');
      closed += 1;
    }
  }
  ctx.metrics.inc('ds_forced_disconnects_total', { app: app.id }, closed);
  sendJson(res, 200, { ok: true, closed });
}
