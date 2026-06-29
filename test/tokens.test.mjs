import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { sign, verify, randomSecret, sha256Hex } = require('../src/lib/tokens.js');

const SECRET = 'test-secret-do-not-use-in-prod';

test('sign + verify round-trip (action)', () => {
  const t = sign(SECRET, 'action', 12345, Date.now() + 60_000);
  const v = verify(SECRET, t);
  assert.equal(v.kind, 'action');
  assert.equal(v.id, 12345);
  assert.ok(!v.error);
});

test('sign + verify round-trip (unsubscribe, no expiry)', () => {
  const t = sign(SECRET, 'unsubscribe', 99, 0);
  const v = verify(SECRET, t);
  assert.equal(v.kind, 'unsubscribe');
  assert.equal(v.id, 99);
});

test('reject bad signature', () => {
  const t = sign(SECRET, 'action', 1, 0);
  const tampered = t.slice(0, -2) + 'aa';
  const v = verify(SECRET, tampered);
  assert.equal(v.error, 'bad_signature');
});

test('reject wrong-secret signature', () => {
  const t = sign(SECRET, 'action', 1, 0);
  const v = verify('another-secret', t);
  assert.equal(v.error, 'bad_signature');
});

test('reject expired tokens', () => {
  const t = sign(SECRET, 'action', 1, Date.now() - 1000);
  const v = verify(SECRET, t);
  assert.equal(v.error, 'expired');
});

test('reject malformed tokens', () => {
  assert.equal(verify(SECRET, 'not-a-token').error, 'malformed');
  assert.equal(verify(SECRET, '').error, 'malformed');
  assert.equal(verify(SECRET, null).error, 'malformed');
});

test('kind cannot be replayed (action vs unsubscribe)', () => {
  const actionTok = sign(SECRET, 'action', 1, 0);
  const v = verify(SECRET, actionTok);
  assert.equal(v.kind, 'action');
  assert.notEqual(v.kind, 'unsubscribe');
});

test('throws when secret not configured', () => {
  assert.throws(() => sign('', 'action', 1, 0), /secret/i);
});

test('randomSecret is URL-safe and unique', () => {
  const a = randomSecret();
  const b = randomSecret();
  assert.notEqual(a, b);
  assert.ok(/^[A-Za-z0-9_-]+$/.test(a), 'URL-safe');
});

test('sha256Hex is deterministic', () => {
  assert.equal(sha256Hex('x'), sha256Hex('x'));
  assert.notEqual(sha256Hex('x'), sha256Hex('y'));
});
