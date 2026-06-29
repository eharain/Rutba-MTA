'use strict';

/**
 * Message class: transactional vs marketing.
 * Pure — tested in test/msgclass.test.mjs.
 *
 * Transactional mail (password resets, receipts, lead notifications) is queue-
 * prioritised and bypasses the per-domain reputation pacing. Marketing mail is
 * sent after all pending transactional, paced by reputation, and carries an
 * unsubscribe link.
 *
 * Default is 'transactional' (fail-safe): a mislabelled send is delivered
 * promptly rather than throttled or unsubscribe-tagged.
 */

const CLASSES = ['transactional', 'marketing'];

function normalizeClass(c) {
  const s = String(c == null ? '' : c).trim().toLowerCase();
  // Accept the legacy 'bulk' synonym so older callers still work.
  if (s === 'marketing' || s === 'bulk') return 'marketing';
  return 'transactional';
}

/** Transactional skips the per-domain reputation delay (still obeys ceiling). */
function bypassesPacing(c) {
  return normalizeClass(c) === 'transactional';
}

/** Marketing-class mail gets List-Unsubscribe + a visible opt-out footer. */
function needsUnsubscribe(c) {
  return normalizeClass(c) === 'marketing';
}

module.exports = { normalizeClass, bypassesPacing, needsUnsubscribe, CLASSES };
