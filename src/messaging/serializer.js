import { DsError, ErrorCode } from '../utils/errors.js';

/**
 * Server -> client application event envelope (see docs/API.md).
 * `target` is "channel" for channel broadcasts and "user" for user-targeted
 * delivery; `channel` is null for the latter.
 */
export function serializeEvent({ id, target, channel, event, data, sentAt }) {
  return JSON.stringify({ type: 'event', id, target, channel: channel ?? null, event, data, sentAt });
}

export function serializeControl(message) {
  return JSON.stringify(message);
}

/**
 * Decodes a client -> server control message. Binary frames are refused;
 * payload size is already bounded by the WebSocket maxPayload setting.
 * The result is plain data; nothing in it is ever executed.
 */
export function parseClientMessage(raw, isBinary) {
  if (isBinary) throw new DsError(ErrorCode.BAD_MESSAGE, 'Binary frames are not supported');
  let msg;
  try {
    msg = JSON.parse(raw.toString('utf8'));
  } catch {
    throw new DsError(ErrorCode.BAD_JSON, 'Message is not valid JSON');
  }
  if (typeof msg !== 'object' || msg === null || Array.isArray(msg) || typeof msg.type !== 'string') {
    throw new DsError(ErrorCode.BAD_MESSAGE, 'Message must be a JSON object with a string "type"');
  }
  return msg;
}
