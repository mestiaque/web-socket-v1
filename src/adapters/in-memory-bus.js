/**
 * Single-process message bus. Delivery happens synchronously inside
 * publish(), so the returned report contains exact counts for this process.
 * Nothing is stored: messages published while no subscriber is connected
 * are gone.
 */
export class InMemoryBus {
  constructor() {
    this.handlers = [];
  }

  subscribe(handler) {
    this.handlers.push(handler);
  }

  async publish(message) {
    const total = { scope: 'local', recipients: 0, sent: 0, dropped: 0 };
    for (const handler of this.handlers) {
      const report = handler(message);
      total.recipients += report.recipients;
      total.sent += report.sent;
      total.dropped += report.dropped;
    }
    return total;
  }

  async close() {
    this.handlers = [];
  }
}
