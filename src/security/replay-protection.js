/**
 * Bounded, in-memory "seen once" registry used for HTTP request nonces and
 * client token identifiers (jti).
 *
 * Scope: a single Node.js process. checkAndAdd() is synchronous, so it is
 * atomic with respect to the event loop. It is NOT shared across processes or
 * hosts; multi-instance deployments must replace it with an atomic shared
 * store (for example Redis `SET key 1 NX PX <ttl>`). See docs/SECURITY.md.
 *
 * When the registry is full of unexpired entries it fails closed: new keys
 * are refused (CAPACITY) rather than evicting entries, because evicting an
 * unexpired entry would re-enable a replay.
 */
export const ReplayResult = Object.freeze({
  ACCEPTED: 'accepted',
  REPLAYED: 'replayed',
  CAPACITY: 'capacity',
});

export class ExpiringKeyStore {
  constructor({ maxEntries, minSweepIntervalMs = 1000 }) {
    this.maxEntries = maxEntries;
    this.minSweepIntervalMs = minSweepIntervalMs;
    this.entries = new Map(); // key -> expiresAt (ms)
    this.lastSweep = 0;
  }

  /**
   * @param {string} key
   * @param {number} expiresAt epoch ms after which the key may be forgotten
   * @param {number} [now]
   */
  checkAndAdd(key, expiresAt, now = Date.now()) {
    const existing = this.entries.get(key);
    if (existing !== undefined) {
      if (existing > now) return ReplayResult.REPLAYED;
      this.entries.delete(key);
    }
    if (this.entries.size >= this.maxEntries) {
      if (now - this.lastSweep >= this.minSweepIntervalMs) this.sweep(now);
      if (this.entries.size >= this.maxEntries) return ReplayResult.CAPACITY;
    }
    this.entries.set(key, expiresAt);
    return ReplayResult.ACCEPTED;
  }

  sweep(now = Date.now()) {
    this.lastSweep = now;
    for (const [key, expiresAt] of this.entries) {
      if (expiresAt <= now) this.entries.delete(key);
    }
  }

  get size() {
    return this.entries.size;
  }
}
