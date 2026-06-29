'use strict';

/**
 * Per-receiving-domain reputation + adaptive send-delay tiers.
 * Pure — unit-tested in test/reputation.test.mjs.
 *
 * Modeled on RightApp's 0–100 score-config: a low score (lots of bounces /
 * complaints / defers) slows our send rate to that domain automatically, so
 * we don't get blocked. Score lifts as outcomes improve.
 */

// Below this many sends we don't have enough signal — treat as warmup-healthy
// (score 80 → 500 ms delay tier, conservative but not punitive).
const DEFAULT_MIN_SAMPLE = 20;
const WARMUP_SCORE = 80;

/**
 * Compute a 0–100 reputation score from a domain's counters.
 *   score = 100 − (bounceRate·300 + complaintRate·1000 + deferRate·50)
 * Clamped to [0, 100]. During warmup (sent < minSample) returns WARMUP_SCORE.
 */
function reputationScore(counts = {}, minSample = DEFAULT_MIN_SAMPLE) {
  const sent = Math.max(0, Number(counts.sent) || 0);
  if (sent < minSample) return WARMUP_SCORE;
  const bounceRate = (Number(counts.bounced) || 0) / sent;
  const complaintRate = (Number(counts.complained) || 0) / sent;
  const deferRate = (Number(counts.deferred) || 0) / sent;
  let score = 100 - complaintRate * 1000 - bounceRate * 300 - deferRate * 50;
  if (score < 0) score = 0;
  if (score > 100) score = 100;
  return Math.round(score);
}

// score → per-message delay (ms) between sends to the same receiving domain.
// Marketing class only — transactional bypasses these tiers.
// Matches FUNCTION.md §4.
const SCORE_DELAY_TIERS = [
  { min: 96, ms: 0 },     // 96–100  full speed
  { min: 86, ms: 500 },   // 86–95   gentle pace
  { min: 71, ms: 1500 },  // 71–85
  { min: 51, ms: 3000 },  // 51–70
  { min: 0,  ms: 6000 },  // 0–50    near-stopped (problem domain)
];

function delayForScore(score) {
  const s = Number(score);
  for (const tier of SCORE_DELAY_TIERS) {
    if (s >= tier.min) return tier.ms;
  }
  return 6000;
}

/**
 * Resolve the effective score given a row from `domain_reputation`. If the
 * row has a `score_override` (admin pinned), that wins.
 */
function effectiveScore(row, minSample = DEFAULT_MIN_SAMPLE) {
  if (!row) return WARMUP_SCORE;
  if (row.score_override != null) return Math.max(0, Math.min(100, Number(row.score_override)));
  return reputationScore(row, minSample);
}

module.exports = {
  reputationScore,
  delayForScore,
  effectiveScore,
  SCORE_DELAY_TIERS,
  DEFAULT_MIN_SAMPLE,
  WARMUP_SCORE,
};
