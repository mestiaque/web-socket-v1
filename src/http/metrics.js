import { createHash, timingSafeEqual } from 'node:crypto';
import { sendError, sendText } from './respond.js';
import { ErrorCode } from '../utils/errors.js';

const digest = (s) => createHash('sha256').update(s).digest();

/**
 * Prometheus metrics. Disabled (404) unless DS_METRICS_TOKEN is set, and
 * then only served with `Authorization: Bearer <token>`. Metrics reveal app
 * ids and traffic volumes, so they are not public.
 */
export function handleMetrics(req, res, ctx) {
  const { metricsToken } = ctx.config;
  if (!metricsToken) return sendError(res, 404, ErrorCode.NOT_FOUND, 'Not found');
  const header = req.headers.authorization ?? '';
  const provided = header.startsWith('Bearer ') ? header.slice(7) : '';
  // Hash both sides so the comparison is constant-time regardless of length.
  if (!timingSafeEqual(digest(provided), digest(metricsToken))) {
    return sendError(res, 401, ErrorCode.AUTH_FAILED, 'Unauthorized', { 'WWW-Authenticate': 'Bearer' });
  }
  sendText(res, 200, ctx.metrics.render(), 'text/plain; version=0.0.4; charset=utf-8');
}
