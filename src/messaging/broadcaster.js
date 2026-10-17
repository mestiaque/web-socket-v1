import { serializeEvent } from './serializer.js';

/**
 * Delivers published messages to sockets connected to THIS process.
 *
 * "sent" means the frame was handed to the socket (ws.send) without
 * exceeding the per-connection buffer limit. It does not mean the browser
 * received or processed it. There is no retry and no persistence.
 *
 * Backpressure: if a connection's unsent buffer (ws.bufferedAmount) plus the
 * new frame would exceed `maxBufferedBytes`, the frame is dropped for that
 * connection and the connection is closed as a slow consumer (4009). The
 * client can reconnect; messages missed in between are not replayed.
 */
export class Broadcaster {
  constructor({ registry, maxBufferedBytes, metrics, logger }) {
    this.registry = registry;
    this.maxBufferedBytes = maxBufferedBytes;
    this.metrics = metrics;
    this.logger = logger;
  }

  /**
   * @param {{ id: string, appId: string, channels: string[], users: string[], event: string, data: unknown, sentAt: string }} message
   * @returns {{ recipients: number, sent: number, dropped: number }}
   */
  deliver(message) {
    const report = { recipients: 0, sent: 0, dropped: 0 };
    const { id, appId, event, data, sentAt } = message;

    for (const channel of message.channels) {
      const subscribers = this.registry.subscribers(appId, channel);
      if (subscribers.size === 0) continue;
      const frame = Buffer.from(serializeEvent({ id, target: 'channel', channel, event, data, sentAt }), 'utf8');
      // Copy: a send may close a slow consumer, which mutates the set.
      for (const conn of [...subscribers]) this.sendTo(conn, frame, report);
    }

    if (message.users.length > 0) {
      const frame = Buffer.from(serializeEvent({ id, target: 'user', channel: null, event, data, sentAt }), 'utf8');
      for (const sub of message.users) {
        for (const conn of [...this.registry.userConnections(appId, sub)]) this.sendTo(conn, frame, report);
      }
    }

    this.metrics.inc('ds_messages_published_total', { app: appId });
    this.metrics.inc('ds_frames_sent_total', { app: appId }, report.sent);
    if (report.dropped > 0) this.metrics.inc('ds_frames_dropped_total', { app: appId }, report.dropped);
    return report;
  }

  /**
   * Sends a server control message (e.g. presence changes) to every
   * subscriber of a channel, except connections of `excludeSub`.
   * Same backpressure rules as events.
   */
  sendToChannel(appId, channel, message, excludeSub) {
    const subscribers = this.registry.subscribers(appId, channel);
    if (subscribers.size === 0) return;
    const frame = Buffer.from(JSON.stringify(message), 'utf8');
    const report = { recipients: 0, sent: 0, dropped: 0 };
    for (const conn of [...subscribers]) {
      if (conn.sub !== excludeSub) this.sendTo(conn, frame, report);
    }
  }

  sendTo(conn, frame, report) {
    report.recipients += 1;
    if (!conn.isOpen()) {
      report.dropped += 1;
      return;
    }
    if (conn.ws.bufferedAmount + frame.length > this.maxBufferedBytes) {
      report.dropped += 1;
      conn.closeSlowConsumer();
      return;
    }
    conn.ws.send(frame, { binary: false }, (err) => {
      if (err) this.metrics.inc('ds_send_errors_total');
    });
    report.sent += 1;
  }
}
