import { instanceId } from '../utils/ids.js';
import { sendJson } from './respond.js';

/**
 * Liveness: the process is running and the event loop responds.
 * `instanceId` changes per process; if repeated calls through a proxy return
 * different ids, more than one process is serving the endpoint, which breaks
 * the single-process in-memory model (see docs/CPANEL.md).
 */
export function handleHealth(_req, res, ctx) {
  sendJson(res, 200, { status: 'ok', instanceId, uptimeSeconds: Math.round((Date.now() - ctx.startedAt) / 1000) });
}

/** Readiness: accepting new connections (false while shutting down). */
export function handleReady(_req, res, ctx) {
  if (ctx.isShuttingDown()) sendJson(res, 503, { status: 'shutting_down', instanceId });
  else sendJson(res, 200, { status: 'ready', instanceId });
}
