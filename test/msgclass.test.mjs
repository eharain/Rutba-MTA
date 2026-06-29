import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { normalizeClass, bypassesPacing, needsUnsubscribe } = require('../src/lib/msgclass.js');

test('normalizeClass defaults to transactional; accepts marketing + legacy bulk', () => {
  assert.equal(normalizeClass('marketing'), 'marketing');
  assert.equal(normalizeClass('MARKETING'), 'marketing');
  assert.equal(normalizeClass('bulk'), 'marketing');           // legacy synonym
  assert.equal(normalizeClass('transactional'), 'transactional');
  assert.equal(normalizeClass('garbage'), 'transactional');
  assert.equal(normalizeClass(undefined), 'transactional');
});

test('transactional bypasses pacing; marketing does not', () => {
  assert.equal(bypassesPacing('transactional'), true);
  assert.equal(bypassesPacing(undefined), true);
  assert.equal(bypassesPacing('marketing'), false);
  assert.equal(bypassesPacing('bulk'), false);
});

test('marketing needs unsubscribe; transactional does not', () => {
  assert.equal(needsUnsubscribe('marketing'), true);
  assert.equal(needsUnsubscribe('bulk'), true);
  assert.equal(needsUnsubscribe('transactional'), false);
  assert.equal(needsUnsubscribe(undefined), false);
});
