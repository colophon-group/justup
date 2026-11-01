// Authenticate the private frontend before accepting its client address. This
// request-local identity only supplies rate buckets, never application ownership.
import { timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { problem } from './store.mjs';

function validSecret(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value)
    && Buffer.from(value, 'base64url').toString('base64url') === value;
}

export function validateTrustedIngressConfig(config) {
  if (config.trustedIngressRequired !== undefined && typeof config.trustedIngressRequired !== 'boolean'
      || config.trustedIngressSecret !== undefined && !validSecret(config.trustedIngressSecret)
      || config.trustedIngressRequired === true && config.trustedIngressSecret === undefined) {
    throw new TypeError('Invalid trusted ingress configuration.');
  }
  return config;
}

function singleHeader(req, name) {
  const values = req.headersDistinct[name];
  return values?.length === 1 && typeof values[0] === 'string' ? values[0] : null;
}

function clientAddress(value) {
  if (typeof value !== 'string' || value.length > 45 || !/^[0-9a-fA-F:.]+$/.test(value)) return null;
  const family = isIP(value);
  if (family === 4) return value;
  if (family !== 6) return null;
  // WHATWG serialization canonicalizes zero compression and hexadecimal case.
  const normalized = new URL(`http://[${value}]`).hostname.slice(1, -1);
  const mapped = /^::ffff:([a-f0-9]+):([a-f0-9]+)$/.exec(normalized);
  if (!mapped) return normalized;
  const high = parseInt(mapped[1], 16), low = parseInt(mapped[2], 16);
  return [high >> 8, high & 255, low >> 8, low & 255].join('.');
}

export function createTrustedIngress(config) {
  validateTrustedIngressConfig(config);
  if (config.trustedIngressSecret === undefined) return req => req.socket.remoteAddress ?? 'unknown';
  const expected = Buffer.from(config.trustedIngressSecret);
  return req => {
    const supplied = singleHeader(req, 'x-justup-ingress');
    if (!validSecret(supplied) || !timingSafeEqual(expected, Buffer.from(supplied))) throw problem('forbidden', 403);
    const address = clientAddress(singleHeader(req, 'x-justup-client-ip'));
    if (address === null) throw problem('forbidden', 403);
    return address;
  };
}
