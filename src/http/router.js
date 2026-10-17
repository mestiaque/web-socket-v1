import { DsError, ErrorCode } from '../utils/errors.js';
import { handleDisconnect } from './disconnect.js';
import { handleHealth, handleReady } from './health.js';
import { handleMetrics } from './metrics.js';
import { handlePresence } from './presence.js';
import { handlePublish } from './publish.js';
import { sendError } from './respond.js';

const ROUTES = {
  '/healthz': { GET: handleHealth },
  '/readyz': { GET: handleReady },
  '/metrics': { GET: handleMetrics },
  '/v1/publish': { POST: handlePublish },
  '/v1/disconnect': { POST: handleDisconnect },
  '/v1/presence': { POST: handlePresence },
};

/** Returns the HTTP request listener. */
export function createRouter(ctx) {
  return async function route(req, res) {
    let pathname;
    try {
      pathname = new URL(req.url, 'http://localhost').pathname;
    } catch {
      return sendError(res, 400, ErrorCode.BAD_MESSAGE, 'Bad request');
    }
    const route = Object.hasOwn(ROUTES, pathname) ? ROUTES[pathname] : undefined;
    if (!route) return sendError(res, 404, ErrorCode.NOT_FOUND, 'Not found');
    const handler = Object.hasOwn(route, req.method) ? route[req.method] : undefined;
    if (!handler) return sendError(res, 405, ErrorCode.METHOD_NOT_ALLOWED, 'Method not allowed', { Allow: Object.keys(route).join(', ') });

    try {
      await handler(req, res, ctx);
    } catch (err) {
      if (err instanceof DsError) {
        const headers = err.details?.retryAfterSeconds ? { 'Retry-After': String(err.details.retryAfterSeconds) } : {};
        if (err.status === 413) headers.Connection = 'close';
        sendError(res, err.status, err.code, err.message, headers);
      } else if (req.destroyed || res.destroyed) {
        ctx.logger.debug('client aborted request', { path: pathname, code: err.code });
      } else {
        ctx.logger.error('unhandled HTTP error', { err, path: pathname });
        sendError(res, 500, ErrorCode.INTERNAL, 'Internal error');
      }
    }
  };
}
