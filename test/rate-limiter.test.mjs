import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { DomainLimiter, nextAllowedAt, isIntervalReady } = require('../src/lib/rate-limiter.js');

test('interval helpers', () => {
  assert.equal(nextAllowedAt(1000, 500), 1500);
  assert.equal(isIntervalReady(1000, 500, 1499), false);
  assert.equal(isIntervalReady(1000, 500, 1500), true);
  assert.equal(isIntervalReady(undefined, 500, 0), true); // never sent → ready
  assert.equal(isIntervalReady(undefined, 0, 0), true);
});

test('per-domain min interval gates sends', () => {
  const lim = new DomainLimiter({ globalMaxInflight: 100, maxInflightPerDomain: 100 });
  assert.equal(lim.canSend('gmail.com', 0, 1000), true);
  lim.acquire('gmail.com', 0);
  lim.release('gmail.com');
  assert.equal(lim.canSend('gmail.com', 500, 1000), false); // too soon
  assert.equal(lim.canSend('gmail.com', 1000, 1000), true); // interval elapsed
});

test('per-domain inflight cap', () => {
  const lim = new DomainLimiter({ globalMaxInflight: 100, maxInflightPerDomain: 2, defaultMinIntervalMs: 0 });
  assert.equal(lim.canSend('aol.com', 0), true);
  lim.acquire('aol.com', 0);
  lim.acquire('aol.com', 0);
  assert.equal(lim.canSend('aol.com', 10), false); // 2 in flight
  lim.release('aol.com');
  assert.equal(lim.canSend('aol.com', 10), true);
});

test('global inflight cap protects our own box', () => {
  const lim = new DomainLimiter({ globalMaxInflight: 1, maxInflightPerDomain: 100, defaultMinIntervalMs: 0 });
  assert.equal(lim.canSend('a.com', 0), true);
  lim.acquire('a.com', 0);
  assert.equal(lim.canSend('b.com', 0), false); // global cap hit even for a fresh domain
  lim.release('a.com');
  assert.equal(lim.canSend('b.com', 0), true);
});
