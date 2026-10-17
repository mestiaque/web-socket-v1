/**
 * Message bus contract.
 *
 * The HTTP publish API hands validated messages to a bus; every server
 * process subscribes to the bus and delivers to its own local sockets.
 *
 * interface MessageBus {
 *   // Publish one message. Resolves with a delivery report.
 *   // In-memory adapter: report.scope === 'local', with exact local counts.
 *   // Shared adapters (future Redis Pub/Sub etc.): report.scope === 'bus',
 *   //   meaning "accepted by the bus"; per-socket counts are not known.
 *   publish(message: BusMessage): Promise<DeliveryReport>
 *
 *   // Register the local delivery handler. Called once per process.
 *   subscribe(handler: (message: BusMessage) => LocalReport): void
 *
 *   close(): Promise<void>
 * }
 *
 * BusMessage = { id, appId, channels: string[], users: string[], event, data, sentAt }
 *
 * Messages must be plain JSON-serializable data so that a networked adapter
 * can transport them unchanged. Adapters must not add persistence semantics
 * they cannot guarantee.
 */
export function assertMessageBus(bus) {
  for (const method of ['publish', 'subscribe', 'close']) {
    if (typeof bus?.[method] !== 'function') throw new TypeError(`Message bus is missing ${method}()`);
  }
  return bus;
}
