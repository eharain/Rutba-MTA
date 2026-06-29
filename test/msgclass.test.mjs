import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { normalizeClass, bypassesPacing } = require('../src/lib/msgclass.js');

test('normalizeClass defaults to transactional', () => {
  assert.equal(normalizeClass('bulk'), 'bulk');
  assert.equal(normalizeClass('BULK'), 'bulk');
  assert.equal(normalizeClass('transactional'), 'transactional');
  assert.equal(normalizeClass('garbage'), 'transactional');
  assert.equal(normalizeClass(undefined), 'transactional');
});

test('transactional bypasses pacing, bulk does not', () => {
  assert.equal(bypassesPacing('transactional'), true);
  assert.equal(bypassesPacing(undefined), true);
  assert.equal(bypassesPacing('bulk'), false);
});
