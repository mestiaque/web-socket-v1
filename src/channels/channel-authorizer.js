import { channelMatches } from './channel-names.js';

/**
 * Decides whether an authenticated connection may subscribe to a channel.
 *
 * A channel is subscribable if it matches either
 *   - one of the application's configured `publicChannels` patterns
 *     (any authenticated connection of that application), or
 *   - one of the `channels` patterns in the connection's verified token
 *     (granted by the application backend for this specific user).
 *
 * Everything else is denied. Channel names carry no implicit meaning.
 *
 * @param {{ publicChannels: ReadonlyArray<string> }} app
 * @param {{ channels: ReadonlyArray<string> }} claims
 * @param {string} channel validated channel name
 * @returns {'public' | 'granted' | null}
 */
export function authorizeSubscription(app, claims, channel) {
  if (app.publicChannels.some((pattern) => channelMatches(pattern, channel))) return 'public';
  if (claims.channels.some((pattern) => channelMatches(pattern, channel))) return 'granted';
  return null;
}
