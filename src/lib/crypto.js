'use strict';

/**
 * Symmetric encryption for sender SMTP credentials at rest.
 * Pure — tested in test/crypto.test.mjs.
 *
 * AES-256-GCM with a per-record random IV. Output format:
 *   "v1:" + base64url(iv) + ":" + base64url(tag) + ":" + base64url(ciphertext)
 * The 'v1:' prefix lets us migrate to a new scheme later without losing rows.
 *
 * The key (`MAILER_SMTP_ENC_KEY`) is interpreted as:
 *   - 64 hex chars  → 32 bytes used directly
 *   - otherwise     → SHA-256(key) used as the 32-byte key
 * This way the operator can paste a strong random hex string OR a passphrase.
 */

const crypto = require('crypto');

function deriveKey(secret) {
  if (!secret) throw new Error('crypto: MAILER_SMTP_ENC_KEY is not configured');
  const s = String(secret);
  if (/^[0-9a-fA-F]{64}$/.test(s)) return Buffer.from(s, 'hex');
  return crypto.createHash('sha256').update(s).digest();
}

function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64urlDecode(str) {
  const s = String(str || '').replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4 ? 4 - (s.length % 4) : 0;
  return Buffer.from(s + '='.repeat(pad), 'base64');
}

function encrypt(plaintext, secret) {
  if (plaintext == null || plaintext === '') return null;
  const key = deriveKey(secret);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${b64url(iv)}:${b64url(tag)}:${b64url(ct)}`;
}

function decrypt(packed, secret) {
  if (packed == null || packed === '') return '';
  const parts = String(packed).split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('crypto: unsupported ciphertext');
  const key = deriveKey(secret);
  const iv = b64urlDecode(parts[1]);
  const tag = b64urlDecode(parts[2]);
  const ct = b64urlDecode(parts[3]);
  const dec = crypto.createDecipheriv('aes-256-gcm', key, iv);
  dec.setAuthTag(tag);
  const pt = Buffer.concat([dec.update(ct), dec.final()]);
  return pt.toString('utf8');
}

module.exports = { encrypt, decrypt };
