import { randomBytes, randomUUID } from 'node:crypto';

/** Opaque identifier for a WebSocket connection. Not a secret. */
export function connectionId() {
  return randomBytes(12).toString('base64url');
}

/** Identifier for a published message. Not a secret. */
export function messageId() {
  return randomUUID();
}

/** Identifier for this process; lets operators detect multiple instances. */
export const instanceId = randomBytes(6).toString('hex');

export const MESSAGE_ID_PATTERN = /^[A-Za-z0-9_.:-]{1,128}$/;
