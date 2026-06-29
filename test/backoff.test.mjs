import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { nextDelaySeconds, maxAttempts, DEFAULT_GAPS_SECONDS } = require('../src/lib/backoff.js');

test('backoff follows the gap schedule then exhausts', () => {
  assert.equal(nextDelaySeconds(1), 60);
  assert.equal(nextDelaySeconds(2), 300);
  assert.equal(nextDelaySeconds(3), 900);
  assert.equal(nextDelaySeconds(4), 3600);
  assert.equal(nextDelaySeconds(5), 10800);
  assert.equal(nextDelaySeconds(6), null); // exhausted → give up
});

test('backoff guards bad input', () => {
  assert.equal(nextDelaySeconds(0), 60);
  assert.equal(nextDelaySeconds(-3), 60);
  assert.equal(nextDelaySeconds(NaN), 60);
});

test('maxAttempts is gaps + 1', () => {
  assert.equal(maxAttempts(), DEFAULT_GAPS_SECONDS.length + 1);
  assert.equal(maxAttempts(), 6);
});
