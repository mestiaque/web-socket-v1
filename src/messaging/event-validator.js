import { DsError, ErrorCode } from '../utils/errors.js';
import { isValidChannelName } from '../channels/channel-names.js';
import { MESSAGE_ID_PATTERN } from '../utils/ids.js';

/**
 * Event names are application-defined and need no server changes. They are
 * treated as opaque strings: never evaluated, never used as object keys on
 * the server, never used to select code paths.
 */
export const EVENT_NAME_PATTERN = /^[A-Za-z0-9_\-.:/\\@]{1,128}$/;
export const USER_ID_MAX_LENGTH = 191;

const ALLOWED_PUBLISH_KEYS = new Set(['channel', 'channels', 'users', 'event', 'data', 'id']);

export function isValidEventName(name) {
  return typeof name === 'string' && EVENT_NAME_PATTERN.test(name);
}

function invalid(code, message) {
  return new DsError(code, message, { status: 422 });
}

/**
 * Validates and normalizes a decoded publish request body.
 *
 * @param {unknown} body
 * @param {{ maxTargets: number }} limits
 * @returns {{ channels: string[], users: string[], event: string, data: unknown, id: string|undefined }}
 */
export function validatePublishRequest(body, { maxTargets }) {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw invalid(ErrorCode.BAD_MESSAGE, 'Body must be a JSON object');
  }
  for (const key of Object.keys(body)) {
    if (!ALLOWED_PUBLISH_KEYS.has(key)) throw invalid(ErrorCode.BAD_MESSAGE, `Unknown field "${key.slice(0, 64)}"`);
  }
  if (body.channel !== undefined && body.channels !== undefined) {
    throw invalid(ErrorCode.BAD_MESSAGE, 'Use either "channel" or "channels", not both');
  }

  const channels = body.channel !== undefined ? [body.channel] : body.channels ?? [];
  if (!Array.isArray(channels)) throw invalid(ErrorCode.INVALID_CHANNEL, '"channels" must be an array');
  for (const channel of channels) {
    if (!isValidChannelName(channel)) throw invalid(ErrorCode.INVALID_CHANNEL, 'Invalid channel name');
  }

  const users = body.users ?? [];
  if (!Array.isArray(users)) throw invalid(ErrorCode.BAD_MESSAGE, '"users" must be an array');
  const normalizedUsers = users.map((u) => {
    const s = Number.isSafeInteger(u) && u >= 0 ? String(u) : u;
    if (typeof s !== 'string' || s.length === 0 || s.length > USER_ID_MAX_LENGTH) {
      throw invalid(ErrorCode.BAD_MESSAGE, 'Each user id must be a non-empty string (max 191 chars) or non-negative integer');
    }
    return s;
  });

  const uniqueChannels = [...new Set(channels)];
  const uniqueUsers = [...new Set(normalizedUsers)];
  if (uniqueChannels.length + uniqueUsers.length === 0) {
    throw invalid(ErrorCode.BAD_MESSAGE, 'At least one channel or user target is required');
  }
  if (uniqueChannels.length + uniqueUsers.length > maxTargets) {
    throw invalid(ErrorCode.BAD_MESSAGE, `At most ${maxTargets} targets (channels + users) per request`);
  }

  if (!isValidEventName(body.event)) throw invalid(ErrorCode.INVALID_EVENT, 'Invalid event name');

  if (body.id !== undefined && (typeof body.id !== 'string' || !MESSAGE_ID_PATTERN.test(body.id))) {
    throw invalid(ErrorCode.BAD_MESSAGE, 'Invalid message id');
  }

  return {
    channels: uniqueChannels,
    users: uniqueUsers,
    event: body.event,
    data: body.data === undefined ? null : body.data,
    id: body.id,
  };
}
