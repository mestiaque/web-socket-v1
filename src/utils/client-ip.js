import { isIP } from 'node:net';

/** Strips the IPv4-mapped IPv6 prefix so "::ffff:10.0.0.1" equals "10.0.0.1". */
export function normalizeIp(ip) {
  if (typeof ip !== 'string') return '';
  const trimmed = ip.trim();
  return trimmed.toLowerCase().startsWith('::ffff:') && isIP(trimmed.slice(7)) === 4 ? trimmed.slice(7) : trimmed;
}

/**
 * Resolves the client IP used for rate limiting and connection limits.
 *
 * X-Forwarded-For is honoured ONLY when the TCP peer is an explicitly
 * configured trusted proxy. The list is walked from the right, skipping
 * trusted proxies, and the first untrusted hop is used; left-most entries
 * are client-controlled and never trusted on their own.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {ReadonlyArray<string>} trustedProxies
 */
export function clientIp(req, trustedProxies) {
  const remote = normalizeIp(req.socket?.remoteAddress ?? '');
  if (trustedProxies.length === 0 || !trustedProxies.includes(remote)) return remote;
  const header = req.headers['x-forwarded-for'];
  if (typeof header !== 'string' || header.trim() === '') return remote;
  const hops = header.split(',').map(normalizeIp);
  for (let i = hops.length - 1; i >= 0; i--) {
    if (!trustedProxies.includes(hops[i])) return isIP(hops[i]) ? hops[i] : remote;
  }
  return remote;
}
