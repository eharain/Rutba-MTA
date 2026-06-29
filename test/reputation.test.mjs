import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { reputationScore, delayForScore, effectiveScore, WARMUP_SCORE, DEFAULT_MIN_SAMPLE } =
  require('../src/lib/reputation.js');

test('warmup: below the sample floor returns WARMUP_SCORE (80)', () => {
  assert.equal(reputationScore({ sent: 5, bounced: 5 }), WARMUP_SCORE);
  assert.equal(reputationScore({}), WARMUP_SCORE);
  assert.equal(WARMUP_SCORE, 80);
});

test('clean sending domain scores 100', () => {
  assert.equal(reputationScore({ sent: 1000, delivered: 1000, bounced: 0, complained: 0 }), 100);
});

test('hard bounces drag the score down (300x weight)', () => {
  // 10% bounce rate → 100 − 0.10·300 = 70
  assert.equal(reputationScore({ sent: 100, bounced: 10 }), 70);
});

test('complaints are punished hardest (1000x weight)', () => {
  // 2% complaint rate → 100 − 0.02·1000 = 80
  assert.equal(reputationScore({ sent: 100, complained: 2 }), 80);
  // heavy complaints floor at 0
  assert.equal(reputationScore({ sent: 100, complained: 50 }), 0);
});

test('defers contribute (50x weight)', () => {
  // 20% defer rate → 100 − 0.20·50 = 90
  assert.equal(reputationScore({ sent: 100, deferred: 20 }), 90);
});

test('delayForScore matches the FUNCTION.md tier table', () => {
  // 96–100 → 0
  assert.equal(delayForScore(100), 0);
  assert.equal(delayForScore(96), 0);
  // 86–95 → 500
  assert.equal(delayForScore(95), 500);
  assert.equal(delayForScore(86), 500);
  // 71–85 → 1500
  assert.equal(delayForScore(85), 1500);
  assert.equal(delayForScore(71), 1500);
  // 51–70 → 3000
  assert.equal(delayForScore(70), 3000);
  assert.equal(delayForScore(51), 3000);
  // 0–50 → 6000
  assert.equal(delayForScore(50), 6000);
  assert.equal(delayForScore(0), 6000);
});

test('effectiveScore respects admin score_override', () => {
  // Override wins over computed.
  assert.equal(effectiveScore({ sent: 1000, bounced: 0, score_override: 50 }), 50);
  // null override falls back to computed.
  assert.equal(effectiveScore({ sent: 1000, bounced: 0, score_override: null }), 100);
  // Out-of-range overrides clamp.
  assert.equal(effectiveScore({ sent: 1000, score_override: 999 }), 100);
  assert.equal(effectiveScore({ sent: 1000, score_override: -50 }), 0);
});

test('DEFAULT_MIN_SAMPLE is exposed', () => {
  assert.equal(DEFAULT_MIN_SAMPLE, 20);
});
