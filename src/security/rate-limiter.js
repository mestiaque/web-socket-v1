/**
 * Token-bucket rate limiting.
 *
 * A bucket holds up to `burst` tokens and refills at `perSecond` tokens per
 * second. Each action consumes one token; an empty bucket means "limited".
 */
export class TokenBucket {
  constructor({ perSecond, burst }, now = Date.now()) {
    this.perSecond = perSecond;
    this.burst = burst;
    this.tokens = burst;
    this.updatedAt = now;
  }

  take(cost = 1, now = Date.now()) {
    const elapsed = Math.max(0, now - this.updatedAt) / 1000;
    this.tokens = Math.min(this.burst, this.tokens + elapsed * this.perSecond);
    this.updatedAt = now;
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }

  /** Milliseconds until `cost` tokens are available. */
  retryAfterMs(cost = 1) {
    const missing = cost - this.tokens;
    return missing <= 0 ? 0 : Math.ceil((missing / this.perSecond) * 1000);
  }
}

/**
 * A set of token buckets keyed by an arbitrary string (IP address, app id).
 * Memory is bounded by `maxKeys`; idle full buckets are swept periodically.
 * When the key table is full the oldest bucket is evicted, which can only
 * make limits more lenient for that key, never block legitimate keys forever.
 */
export class KeyedRateLimiter {
  constructor({ perSecond, burst, maxKeys = 100_000 }) {
    this.perSecond = perSecond;
    this.burst = burst;
    this.maxKeys = maxKeys;
    this.buckets = new Map();
  }

  take(key, cost = 1, now = Date.now(), limits = null) {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= this.maxKeys) this.buckets.delete(this.buckets.keys().next().value);
      bucket = new TokenBucket(limits ?? { perSecond: this.perSecond, burst: this.burst }, now);
      this.buckets.set(key, bucket);
    }
    return bucket.take(cost, now);
  }

  /** True when `cost` tokens are available for `key`, without consuming them. */
  peek(key, cost = 1, now = Date.now()) {
    const bucket = this.buckets.get(key);
    if (!bucket) return true;
    const elapsed = Math.max(0, now - bucket.updatedAt) / 1000;
    return Math.min(bucket.burst, bucket.tokens + elapsed * bucket.perSecond) >= cost;
  }

  retryAfterMs(key, cost = 1) {
    return this.buckets.get(key)?.retryAfterMs(cost) ?? 0;
  }

  /** Removes buckets that have fully refilled (equivalent to absent). */
  sweep(now = Date.now()) {
    for (const [key, bucket] of this.buckets) {
      const elapsed = (now - bucket.updatedAt) / 1000;
      if (bucket.tokens + elapsed * bucket.perSecond >= bucket.burst) this.buckets.delete(key);
    }
  }

  get size() {
    return this.buckets.size;
  }
}

/** Per-minute limit expressed as a token bucket. */
export function perMinute(limit) {
  return { perSecond: limit / 60, burst: limit };
}
