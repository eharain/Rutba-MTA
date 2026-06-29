import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { reputationScore, delayForScore, MIN_SAMPLE } = require('../src/lib/reputation.js');

test('warmup: below the sample floor scores 100 (assume healthy)', () => {
  assert.equal(reputationScore({ sent: 5, bounced: 5 }), 100);
  assert.equal(reputationScore({}), 100);
});

test('clean sending domain scores high', () => {
  assert.equal(reputationScore({ sent: 1000, delivered: 1000, bounced: 0, complained: 0 }), 100);
});

test('hard bounces drag the score down', () => {
  // 10% bounce rate → 100 - 0.10*300 = 70
  assert.equal(reputationScore({ sent: 100, bounced: 10 }), 70);
});

test('complaints are punished hardest', () => {
  // 2% complaint rate → 100 - 0.02*1000 = 80
  assert.equal(reputationScore({ sent: 100, complained: 2 }), 80);
  // heavy complaints floor at 0
  assert.equal(reputationScore({ sent: 100, complained: 50 }), 0);
});

test('delayForScore maps to RightApp-style tiers', () => {
  assert.equal(delayForScore(100), 0);
  assert.equal(delayForScore(96), 0);
  assert.equal(delayForScore(95), 1000);
  assert.equal(delayForScore(90), 2000);
  assert.equal(delayForScore(80), 4000);
  assert.equal(delayForScore(60), 5000);
  assert.equal(delayForScore(10), 6000);
  assert.equal(delayForScore(0), 6000);
});

test('MIN_SAMPLE is exported and sane', () => {
  assert.ok(MIN_SAMPLE >= 1);
});
