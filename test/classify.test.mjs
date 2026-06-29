import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { classifyError, shouldSuppress } = require('../src/lib/classify.js');

test('5xx SMTP responses are permanent', () => {
  assert.equal(classifyError({ responseCode: 550 }), 'permanent');
  assert.equal(classifyError({ responseCode: 553 }), 'permanent');
});

test('4xx SMTP responses are transient (greylisting, mailbox full)', () => {
  assert.equal(classifyError({ responseCode: 450 }), 'transient');
  assert.equal(classifyError({ responseCode: 421 }), 'transient');
  assert.equal(classifyError({ responseCode: 452 }), 'transient');
});

test('network errors are transient', () => {
  assert.equal(classifyError({ code: 'ETIMEDOUT' }), 'transient');
  assert.equal(classifyError({ code: 'ECONNECTION' }), 'transient');
  assert.equal(classifyError({ code: 'ESOCKET' }), 'transient');
});

test('unknown errors default to transient (safer to retry)', () => {
  assert.equal(classifyError({}), 'transient');
  assert.equal(classifyError({ code: 'WAT' }), 'transient');
});

test('EENVELOPE is permanent but never suppresses (our-side problem)', () => {
  assert.equal(classifyError({ code: 'EENVELOPE' }), 'permanent');
  assert.equal(shouldSuppress({ code: 'EENVELOPE' }), false);
});

test('recipient-rejection codes suppress', () => {
  assert.equal(shouldSuppress({ responseCode: 550, response: '550 5.1.1 user unknown' }), true);
  assert.equal(shouldSuppress({ responseCode: 550, response: '550 mailbox unavailable' }), true);
  assert.equal(shouldSuppress({ responseCode: 553, response: '553 user not local' }), true);
});

test('transient failures never suppress', () => {
  assert.equal(shouldSuppress({ responseCode: 450, response: '450 4.2.1 try later' }), false);
  assert.equal(shouldSuppress({ code: 'ETIMEDOUT' }), false);
});
