/**
 * Protocol-level heartbeat. Every interval each connection that has not
 * answered the previous ping (and sent nothing else) is terminated; the rest
 * are pinged. Browsers answer pings automatically. A dead peer is therefore
 * detected within roughly two intervals.
 */
export class Heartbeat {
  constructor({ connections, intervalMs, metrics, logger }) {
    this.connections = connections;
    this.intervalMs = intervalMs;
    this.metrics = metrics;
    this.logger = logger;
    this.timer = null;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.timer.unref?.();
  }

  tick() {
    for (const conn of this.connections) {
      if (!conn.isAlive) {
        this.metrics.inc('ds_heartbeat_timeouts_total');
        conn.log.debug('heartbeat timeout; terminating');
        conn.ws.terminate();
        continue;
      }
      conn.isAlive = false;
      try {
        conn.ws.ping();
      } catch {
        conn.ws.terminate();
      }
    }
  }

  stop() {
    clearInterval(this.timer);
    this.timer = null;
  }
}
