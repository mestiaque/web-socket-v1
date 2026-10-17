/**
 * Tracks live connections with per-application and per-IP counters so the
 * handshake can enforce connection limits in O(1).
 */
export class ConnectionTracker {
  constructor() {
    this.all = new Set();
    this.byApp = new Map();
    this.byIp = new Map();
  }

  add(conn) {
    this.all.add(conn);
    this.byApp.set(conn.appId, (this.byApp.get(conn.appId) ?? 0) + 1);
    this.byIp.set(conn.ip, (this.byIp.get(conn.ip) ?? 0) + 1);
  }

  remove(conn) {
    if (!this.all.delete(conn)) return;
    decrement(this.byApp, conn.appId);
    decrement(this.byIp, conn.ip);
  }

  get size() {
    return this.all.size;
  }

  countForApp(appId) {
    return this.byApp.get(appId) ?? 0;
  }

  countForIp(ip) {
    return this.byIp.get(ip) ?? 0;
  }

  [Symbol.iterator]() {
    return this.all[Symbol.iterator]();
  }
}

function decrement(map, key) {
  const next = (map.get(key) ?? 1) - 1;
  if (next <= 0) map.delete(key);
  else map.set(key, next);
}
