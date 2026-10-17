/**
 * In-memory indexes of channel subscriptions and authenticated users.
 *
 * Every key is namespaced by application id, using a NUL separator that
 * cannot appear in validated app ids, channel names or user ids. A channel
 * called "orders" in app A and app B therefore maps to two unrelated sets.
 *
 * State is per process and is lost on restart; clients re-subscribe on
 * reconnect (the SDK does this automatically).
 */
const SEP = '\u0000';
const EMPTY = new Set();

export class SubscriptionRegistry {
  constructor() {
    this.channels = new Map(); // appId SEP channel -> Set<conn>
    this.users = new Map(); // appId SEP sub -> Set<conn>
  }

  static key(appId, name) {
    return `${appId}${SEP}${name}`;
  }

  addSubscription(conn, channel) {
    const key = SubscriptionRegistry.key(conn.appId, channel);
    let set = this.channels.get(key);
    if (!set) {
      set = new Set();
      this.channels.set(key, set);
    }
    set.add(conn);
  }

  removeSubscription(conn, channel) {
    const key = SubscriptionRegistry.key(conn.appId, channel);
    const set = this.channels.get(key);
    if (!set) return;
    set.delete(conn);
    if (set.size === 0) this.channels.delete(key);
  }

  addUser(conn) {
    const key = SubscriptionRegistry.key(conn.appId, conn.sub);
    let set = this.users.get(key);
    if (!set) {
      set = new Set();
      this.users.set(key, set);
    }
    set.add(conn);
  }

  removeUser(conn) {
    if (conn.sub === null || conn.sub === undefined) return;
    const key = SubscriptionRegistry.key(conn.appId, conn.sub);
    const set = this.users.get(key);
    if (!set) return;
    set.delete(conn);
    if (set.size === 0) this.users.delete(key);
  }

  /** @returns {ReadonlySet<object>} */
  subscribers(appId, channel) {
    return this.channels.get(SubscriptionRegistry.key(appId, channel)) ?? EMPTY;
  }

  /** @returns {ReadonlySet<object>} */
  userConnections(appId, sub) {
    return this.users.get(SubscriptionRegistry.key(appId, sub)) ?? EMPTY;
  }

  stats() {
    let subscriptions = 0;
    for (const set of this.channels.values()) subscriptions += set.size;
    return { channels: this.channels.size, users: this.users.size, subscriptions };
  }
}
