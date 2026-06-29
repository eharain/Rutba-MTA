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

test('tampered ciphertext fails', () => {
  const ct = encrypt('hunter2', KEY);
  const parts = ct.split(':');
  parts[3] = parts[3].replace(/.$/, 'A');
  assert.throws(() => decrypt(parts.join(':'), KEY));
});

test('null / empty input', () => {
  assert.equal(encrypt(null, KEY), null);
  assert.equal(encrypt('', KEY), null);
  assert.equal(decrypt('', KEY), '');
});

test('throws without a key', () => {
  assert.throws(() => encrypt('x', ''));
});
