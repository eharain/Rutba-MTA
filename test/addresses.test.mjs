import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { normalizeAddress, domainOf, isValidEmail } = require('../src/lib/addresses.js');

test('normalizeAddress lower-cases and trims', () => {
  assert.equal(normalizeAddress('  Foo@Bar.COM '), 'foo@bar.com');
  assert.equal(normalizeAddress(null), '');
  assert.equal(normalizeAddress(undefined), '');
});

test('domainOf extracts the receiving domain', () => {
  assert.equal(domainOf('User@Example.com'), 'example.com');
  assert.equal(domainOf('a@b@gmail.com'), 'gmail.com');
  assert.equal(domainOf('no-at'), '');
});

test('isValidEmail is a lenient sanity gate', () => {
  assert.equal(isValidEmail('a@b.co'), true);
  assert.equal(isValidEmail('nope'), false);
  assert.equal(isValidEmail('a@b'), false);
  assert.equal(isValidEmail('a b@c.com'), false);
});
