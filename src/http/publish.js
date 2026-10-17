import { validatePublishRequest } from '../messaging/event-validator.js';
import { messageId } from '../utils/ids.js';
import { sendJson } from './respond.js';
import { authenticateSignedRequest } from './signed-request.js';

/**
 * POST /v1/publish — signed server-to-server publish.
 *
 * A 200 response means: the request was authenticated, validated, and
 * handed to the message bus, and (for the in-memory bus) a send was
 * attempted on every matching local socket. `delivery.sent` counts frames
 * handed to sockets, NOT frames received or processed by browsers.
 */
export async function handlePublish(req, res, ctx) {
  const { app, body } = await authenticateSignedRequest(req, ctx);
  const request = validatePublishRequest(body, { maxTargets: ctx.config.limits.maxPublishTargets });

  const message = {
    id: request.id ?? messageId(),
    appId: app.id,
    channels: request.channels,
    users: request.users,
    event: request.event,
    data: request.data,
    sentAt: new Date().toISOString(),
  };
  const delivery = await ctx.bus.publish(message);

  ctx.logger.debug('published', {
    appId: app.id,
    messageId: message.id,
    event: message.event,
    channels: message.channels.length,
    users: message.users.length,
    sent: delivery.sent,
  });

  sendJson(res, 200, { ok: true, id: message.id, acceptedAt: message.sentAt, delivery });
}
