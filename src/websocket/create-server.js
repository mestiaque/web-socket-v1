import { WebSocketServer } from 'ws';
import { ClientConnection } from './connection.js';
import { checkUpgrade } from './handshake.js';

/**
 * Attaches the WebSocket endpoint to an existing HTTP server.
 *
 * `ws` handles RFC 6455 framing, masking, UTF-8 validation, control frames
 * and maxPayload enforcement (closing with 1009 when exceeded).
 * permessage-deflate is disabled: it costs memory per connection and CPU
 * per message and has a history of resource-exhaustion issues; payloads
 * here are small JSON envelopes.
 */
export function attachWebSocketServer(httpServer, ctx) {
  const wss = new WebSocketServer({
    noServer: true,
    clientTracking: false,
    perMessageDeflate: false,
    maxPayload: ctx.config.limits.maxPayloadBytes,
  });

  wss.on('error', (err) => ctx.logger.error('websocket server error', { err }));

  httpServer.on('upgrade', (req, socket, head) => {
    socket.on('error', (err) => ctx.logger.debug('upgrade socket error', { code: err.code }));
    const result = checkUpgrade(req, socket, ctx);
    if (!result.ok) return;
    wss.handleUpgrade(req, socket, head, (ws) => {
      new ClientConnection(ws, result, ctx).start();
    });
  });

  return wss;
}
