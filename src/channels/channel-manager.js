import { DsError, ErrorCode } from '../utils/errors.js';
import { authorizeSubscription } from './channel-authorizer.js';
import { isValidChannelName } from './channel-names.js';
import { SubscriptionRegistry } from './subscription-registry.js';

/**
 * Coordinates validation, authorization, limits and registry updates for
 * subscribe/unsubscribe operations, and cleans up when connections close.
 */
export class ChannelManager {
  /**
   * @param {{ maxSubscriptionsPerConnection: number, registry?: SubscriptionRegistry,
   *           presence?: import('./presence-manager.js').PresenceManager | null }} opts
   */
  constructor({ maxSubscriptionsPerConnection, registry = new SubscriptionRegistry(), presence = null }) {
    this.maxSubscriptionsPerConnection = maxSubscriptionsPerConnection;
    this.registry = registry;
    this.presence = presence;
  }

  isPresence(conn, channel) {
    return this.presence !== null && this.presence.isPresenceChannel(conn.app, channel);
  }

  /**
   * @param {{ appId: string, app: object, claims: object, channels: Set<string> }} conn authenticated connection
   * @param {unknown} channel
   * @returns {{ alreadySubscribed: boolean, access: 'public'|'granted', presence?: { count: number, members: object[] } }}
   */
  subscribe(conn, channel) {
    if (!isValidChannelName(channel)) throw new DsError(ErrorCode.INVALID_CHANNEL, 'Invalid channel name');
    const access = authorizeSubscription(conn.app, conn.claims, channel);
    if (!access) throw new DsError(ErrorCode.FORBIDDEN, 'Not authorized for this channel', { status: 403 });
    const presence = this.isPresence(conn, channel);
    if (conn.channels.has(channel)) {
      return { alreadySubscribed: true, access, ...(presence && { presence: this.presence.snapshot(conn.appId, channel) }) };
    }
    if (conn.channels.size >= this.maxSubscriptionsPerConnection) {
      throw new DsError(ErrorCode.SUBSCRIPTION_LIMIT, `Subscription limit of ${this.maxSubscriptionsPerConnection} reached`);
    }
    if (presence && !this.presence.canJoin(conn, channel)) {
      throw new DsError(ErrorCode.PRESENCE_FULL, 'Presence channel is full');
    }
    conn.channels.add(channel);
    this.registry.addSubscription(conn, channel);
    if (presence) return { alreadySubscribed: false, access, presence: this.presence.join(conn, channel) };
    return { alreadySubscribed: false, access };
  }

  /** @returns {boolean} whether the connection was subscribed */
  unsubscribe(conn, channel) {
    if (!isValidChannelName(channel)) throw new DsError(ErrorCode.INVALID_CHANNEL, 'Invalid channel name');
    if (!conn.channels.delete(channel)) return false;
    this.registry.removeSubscription(conn, channel);
    if (this.isPresence(conn, channel)) this.presence.leave(conn, channel);
    return true;
  }

  registerUser(conn) {
    this.registry.addUser(conn);
  }

  /** Removes every subscription and user index entry for a connection. */
  removeConnection(conn) {
    for (const channel of conn.channels) {
      this.registry.removeSubscription(conn, channel);
      if (this.isPresence(conn, channel)) this.presence.leave(conn, channel);
    }
    conn.channels.clear();
    this.registry.removeUser(conn);
  }
}
