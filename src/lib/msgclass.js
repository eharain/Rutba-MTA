'use strict';

/**
 * Message class: transactional vs bulk. Pure — tested in test/msgclass.test.mjs.
 *
 * Transactional mail (password resets, receipts, lead notifications) must go out
 * immediately and bypasses the drip/bleed pacing. Bulk/marketing is paced and is
 * subject to per-tenant unsubscribe. Default is transactional (fail-safe: a
 * mislabelled send is delivered promptly rather than throttled).
 */

const CLASSES = ['transactional', 'bulk'];

function normalizeClass(c) {
  return String(c == null ? '' : c).trim().toLowerCase() === 'bulk' ? 'bulk' : 'transactional';
}

/** Transactional sends skip the reputation/drip delay (but still obey concurrency). */
function bypassesPacing(c) {
  return normalizeClass(c) === 'transactional';
}

module.exports = { normalizeClass, bypassesPacing, CLASSES };
