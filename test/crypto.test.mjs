import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { encrypt, decrypt } = require('../src/lib/crypto.js');

const KEY = 'a'.repeat(64);  // 64 hex chars = 32 bytes
const PASSPHRASE = 'a-strong-passphrase';

test('round-trip with hex key', () => {
  const ct = encrypt('hunter2', KEY);
  assert.ok(ct.startsWith('v1:'));
  assert.equal(decrypt(ct, KEY), 'hunter2');
});

test('round-trip with passphrase (hashed to key)', () => {
  const ct = encrypt('hunter2', PASSPHRASE);
  assert.equal(decrypt(ct, PASSPHRASE), 'hunter2');
});

test('different IV per call → different ciphertext for same plaintext', () => {
  const a = encrypt('same', KEY);
  const b = encrypt('same', KEY);
  assert.notEqual(a, b);
});

test('wrong key fails the GCM auth tag', () => {
  const ct = encrypt('hunter2', KEY);
  assert.throws(() => decrypt(ct, 'b'.repeat(64)));
});

/**
 * Tamper with the ciphertext by flipping a BYTE, not a base64 character.
 *
 * Editing the last character of the payload does not reliably change anything.
 * 'hunter2' is 7 bytes, so the final base64 group carries a single byte and
 * its second character contributes only two bits - the low four bits of that
 * character are discarded on decode. Sixteen of the sixty-four alphabet
 * characters therefore decode to the same byte as any other in their group,
 * and the "tampered" ciphertext was byte-identical to the original.
 *
 * That handed decrypt() a perfectly valid ciphertext about a quarter of the
 * time, GCM correctly did not throw, and the assertion failed - so the test
 * looked flaky while what it was really doing was passing on a false premise
 * the other three quarters of the time. An authenticated-encryption tamper
 * check that only sometimes tampers is not one.
 */
function flipFirstCipherByte(packed) {
  const parts = packed.split(':');
  const b64 = parts[3].replace(/-/g, '+').replace(/_/g, '/');
  const raw = Buffer.from(b64 + '='.repeat(b64.length % 4 ? 4 - (b64.length % 4) : 0), 'base64');
  raw[0] ^= 0xff;
  parts[3] = raw.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return parts.join(':');
}

test('tampered ciphertext fails', () => {
  const ct = encrypt('hunter2', KEY);
  const tampered = flipFirstCipherByte(ct);
  assert.notEqual(tampered, ct, 'the tamper must actually change the ciphertext');
  assert.throws(() => decrypt(tampered, KEY));
});

test('null / empty input', () => {
  assert.equal(encrypt(null, KEY), null);
  assert.equal(encrypt('', KEY), null);
  assert.equal(decrypt('', KEY), '');
});

test('throws without a key', () => {
  assert.throws(() => encrypt('x', ''));
});
