import { DsError, ErrorCode } from '../utils/errors.js';

/**
 * Reads an HTTP request body into a Buffer, enforcing a byte limit.
 * The exact bytes are returned because request signatures cover the raw body.
 *
 * @param {import('node:http').IncomingMessage} req
 * @param {number} limit
 * @returns {Promise<Buffer>}
 */
export function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = req.headers['content-length'];
    if (declared !== undefined && Number(declared) > limit) {
      req.resume();
      reject(new DsError(ErrorCode.PAYLOAD_TOO_LARGE, `Request body exceeds ${limit} bytes`, { status: 413 }));
      return;
    }
    const chunks = [];
    let size = 0;
    let done = false;
    const finish = (err, value) => {
      if (done) return;
      done = true;
      req.off('data', onData);
      req.off('end', onEnd);
      req.off('error', onError);
      if (err) reject(err);
      else resolve(value);
    };
    const onData = (chunk) => {
      size += chunk.length;
      if (size > limit) {
        req.resume();
        finish(new DsError(ErrorCode.PAYLOAD_TOO_LARGE, `Request body exceeds ${limit} bytes`, { status: 413 }));
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = () => finish(null, Buffer.concat(chunks, size));
    const onError = (err) => finish(err);
    req.on('data', onData);
    req.on('end', onEnd);
    req.on('error', onError);
  });
}

/** Returns true when a value would serialize to more than `limit` UTF-8 bytes. */
export function exceedsBytes(str, limit) {
  return Buffer.byteLength(str, 'utf8') > limit;
}
