'use strict';

/**
 * HMAC-signed opaque tokens for action interception and unsubscribe links.
 * Pure — tested in test/tokens.test.mjs.
 *
 * Design: the token = base64url(payload) . base64url(hmac(secret, payload)).
 * The payload is a tiny binary record: kind(1) + id(8 BE) + expiresAt(8 BE),
 * fixed 17 bytes → 23-char base64url. The MAC is 32 bytes → 43-char base64url.
 * Total ~67 chars — short enough for an email link, unforgeable without the
 * server secret, and verifiable with no DB lookup (the DB row is only consulted
 * to record the click outcome).
 *
 * `kind` namespaces the token so an action token cannot be replayed as an
 * unsubscribe token and vice versa.
 */

const crypto = require('crypto');

const KIND_ACTION = 1;
const KIND_UNSUBSCRIBE = 2;
const KINDS = { action: KIND_ACTION, unsubscribe: KIND_UNSUBSCRIBE };
const KIND_NAMES = { [KIND_ACTION]: 'action', [KIND_UNSUBSCRIBE]: 'unsubscribe' };

function b64urlEncode(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  const s = String(str || '').replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4 ? 4 - (s.length % 4) : 0;
  return Buffer.from(s + '='.repeat(pad), 'base64');
}

function hmac(secret, data) {
  if (!secret) throw new Error('tokens: HMAC secret is not configured');
  return crypto.createHmac('sha256', String(secret)).update(data).digest();
}

function packPayload(kind, id, expiresAtSec) {
  const buf = Buffer.alloc(17);
  buf.writeUInt8(kind, 0);
  buf.writeBigUInt64BE(BigInt(id), 1);
  buf.writeBigUInt64BE(BigInt(Math.max(0, Math.floor(expiresAtSec || 0))), 9);
  return buf;
}

function unpackPayload(buf) {
  if (!Buffer.isBuffer(buf) || buf.length !== 17) return null;
  return {
    kind: buf.readUInt8(0),
    id: Number(buf.readBigUInt64BE(1)),
    expiresAt: Number(buf.readBigUInt64BE(9)),
  };
}

/**
 * Sign a token. `kind` is a string ('action' | 'unsubscribe'). `expiresAtMs`
 * is a JS millisecond timestamp; pass 0 for no expiry.
 */
function sign(secret, kind, id, expiresAtMs = 0) {
  const k = KINDS[kind];
  if (!k) throw new Error(`tokens: unknown kind ${kind}`);
  const payload = packPayload(k, id, Math.floor((expiresAtMs || 0) / 1000));
  const mac = hmac(secret, payload);
  return `${b64urlEncode(payload)}.${b64urlEncode(mac)}`;
}

/**
 * Verify a token. Returns { kind, id, expiresAt } on success or { error }.
 * `nowMs` defaults to Date.now() (overridable for tests).
 */
function verify(secret, token, nowMs = Date.now()) {
  if (typeof token !== 'string' || token.indexOf('.') < 0) return { error: 'malformed' };
  const [payloadB64, macB64] = token.split('.');
  let payload, mac;
  try {
    payload = b64urlDecode(payloadB64);
    mac = b64urlDecode(macB64);
  } catch (_) { return { error: 'malformed' }; }
  const expected = hmac(secret, payload);
  if (expected.length !== mac.length || !crypto.timingSafeEqual(expected, mac)) {
    return { error: 'bad_signature' };
  }
  const unpacked = unpackPayload(payload);
  if (!unpacked) return { error: 'malformed' };
  if (unpacked.expiresAt > 0 && unpacked.expiresAt * 1000 < nowMs) {
    return { error: 'expired', kind: KIND_NAMES[unpacked.kind], id: unpacked.id };
  }
  return { kind: KIND_NAMES[unpacked.kind], id: unpacked.id, expiresAt: unpacked.expiresAt };
}

/** Generate a random trust-token / webhook-secret (URL-safe base64, 32 bytes). */
function randomSecret(bytes = 32) {
  return b64urlEncode(crypto.randomBytes(bytes));
}

/** SHA-256 hex of a value — used to store trust-token hashes for verification. */
function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

module.exports = { sign, verify, randomSecret, sha256Hex, KINDS, KIND_NAMES };
