'use strict';

/**
 * Per-receiving-domain sender reputation + drip/bleed pacing.
 * Pure — unit-tested in test/reputation.test.mjs.
 *
 * Modeled on RightApp's score-config (0-100 score → per-message delay tier).
 * A low score (lots of bounces/complaints to that domain) slows our send rate
 * to that domain — "receiver + receiving-server care" so we don't get blocked.
 */

// Below this many sends we don't have enough signal — treat as healthy (warmup).
const MIN_SAMPLE = 20;

/**
 * Compute a 0-100 reputation score for one receiving domain from its counters.
 * counts: { sent, delivered, bounced, complained, deferred }
 */
function reputationScore(counts = {}) {
  const sent = Math.max(0, Number(counts.sent) || 0);
  if (sent < MIN_SAMPLE) return 100;
  const bounceRate = (Number(counts.bounced) || 0) / sent;
  const complaintRate = (Number(counts.complained) || 0) / sent;
  const deferRate = (Number(counts.deferred) || 0) / sent;
  // Complaints are the harshest signal, then hard bounces, then deferrals.
  let score = 100 - complaintRate * 1000 - bounceRate * 300 - deferRate * 50;
  if (score < 0) score = 0;
  if (score > 100) score = 100;
  return Math.round(score);
}

// score → per-message delay (ms). Higher score = faster sending. RightApp tiers.
const SCORE_DELAY_TIERS = [
  { min: 96, ms: 0 },
  { min: 91, ms: 1000 },
  { min: 86, ms: 2000 },
  { min: 81, ms: 3000 },
  { min: 76, ms: 4000 },
  { min: 51, ms: 5000 },
  { min: 0, ms: 6000 },
];

/** Per-message bleed delay (ms) for a given reputation score. */
function delayForScore(score) {
  const s = Number(score);
  for (const tier of SCORE_DELAY_TIERS) {
    if (s >= tier.min) return tier.ms;
  }
  return 6000;
}

module.exports = { reputationScore, delayForScore, SCORE_DELAY_TIERS, MIN_SAMPLE };
