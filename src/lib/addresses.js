'use strict';

/**
 * Pure address helpers. No I/O — unit-tested in test/addresses.test.mjs.
 */

/** Lower-case + trim. The canonical form stored everywhere (suppression keys etc). */
function normalizeAddress(addr) {
  return String(addr == null ? '' : addr).trim().toLowerCase();
}

/** The receiving domain (after the last @), normalized. '' if none. */
function domainOf(addr) {
  const s = normalizeAddress(addr);
  const at = s.lastIndexOf('@');
  return at >= 0 ? s.slice(at + 1) : '';
}

// Deliberately lenient: we are not an address validator, just a sanity gate to
// avoid queueing obvious garbage. Real validity is proven by delivery/bounce.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function isValidEmail(addr) {
  return EMAIL_RE.test(normalizeAddress(addr));
}

module.exports = { normalizeAddress, domainOf, isValidEmail };
