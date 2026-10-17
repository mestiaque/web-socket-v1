const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Cache-Control': 'no-store',
  'Referrer-Policy': 'no-referrer',
};

export function sendJson(res, status, body, extraHeaders = {}) {
  if (res.headersSent) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    ...extraHeaders,
  });
  res.end(payload);
}

export function sendText(res, status, text, contentType = 'text/plain; charset=utf-8') {
  if (res.headersSent) return;
  res.writeHead(status, { ...SECURITY_HEADERS, 'Content-Type': contentType, 'Content-Length': Buffer.byteLength(text) });
  res.end(text);
}

/** Client-safe error body; never includes stack traces or internals. */
export function sendError(res, status, code, message, extraHeaders) {
  sendJson(res, status, { ok: false, error: { code, message } }, extraHeaders);
}
