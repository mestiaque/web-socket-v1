import { isValidChannelName } from '../channels/channel-names.js';
import { USER_ID_MAX_LENGTH } from '../messaging/event-validator.js';
import { DsError, ErrorCode } from '../utils/errors.js';
import { sendJson } from './respond.js';
import { authenticateSignedRequest } from './signed-request.js';

/**
 * POST /v1/presence — signed query of online state in the calling app.
 *
 *   { "users": ["42", "43"] }  -> { "users": { "42": true, "43": false } }
 *     A user is online while at least one authenticated connection is open.
 *   { "channel": "online" }     -> member list of a presence channel
 *     (or only the subscriber count for a non-presence channel).
 *
 * Both fields may be combined. State is this process's in-memory view.
 */
export async function handlePresence(req, res, ctx) {
  const { app, body } = await authenticateSignedRequest(req, ctx);
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new DsError(ErrorCode.BAD_MESSAGE, 'Body must be a JSON object', { status: 422 });
  }
  for (const k of Object.keys(body)) {
    if (k !== 'users' && k !== 'channel') throw new DsError(ErrorCode.BAD_MESSAGE, `Unknown field "${k.slice(0, 64)}"`, { status: 422 });
  }
  if (body.users === undefined && body.channel === undefined) {
    throw new DsError(ErrorCode.BAD_MESSAGE, 'Provide "users" and/or "channel"', { status: 422 });
  }

  const result = { ok: true };
  const { registry } = ctx.channels;

  if (body.users !== undefined) {
    const max = ctx.config.limits.maxPresenceMembers;
    if (!Array.isArray(body.users) || body.users.length === 0 || body.users.length > max) {
      throw new DsError(ErrorCode.BAD_MESSAGE, `"users" must be a non-empty array (max ${max})`, { status: 422 });
    }
    result.users = {};
    for (const raw of body.users) {
      const sub = Number.isSafeInteger(raw) && raw >= 0 ? String(raw) : raw;
      if (typeof sub !== 'string' || sub.length === 0 || sub.length > USER_ID_MAX_LENGTH) {
        throw new DsError(ErrorCode.BAD_MESSAGE, 'Invalid user id', { status: 422 });
      }
      result.users[sub] = registry.userConnections(app.id, sub).size > 0;
    }
  }

  if (body.channel !== undefined) {
    if (!isValidChannelName(body.channel)) throw new DsError(ErrorCode.INVALID_CHANNEL, 'Invalid channel name', { status: 422 });
    const isPresence = ctx.channels.presence.isPresenceChannel(app, body.channel);
    result.channel = {
      name: body.channel,
      presence: isPresence,
      subscriptions: registry.subscribers(app.id, body.channel).size,
      ...(isPresence && ctx.channels.presence.snapshot(app.id, body.channel)),
    };
  }

  sendJson(res, 200, result);
}
