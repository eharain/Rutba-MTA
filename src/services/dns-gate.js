'use strict';

/**
 * The DNS gate: no required records, no relay (owner decision, 2026-08-25).
 *
 * `ensureVerified(sender)` is the one question the send paths ask. It caches
 * verdicts in sender_domain_dns per (domain), rechecking on a cadence rather
 * than per message: a `verified` domain is re-examined every
 * `recheckSeconds` (records can lapse), a `failed`/`unverified` one retried
 * after `failRetrySeconds` (the sender is probably publishing records right
 * now and should not wait six hours for the fix to count).
 *
 * Enforcement points, both ends:
 *   - /v1/send + /v1/send/batch refuse at ENQUEUE (422, before any outbox
 *     row exists) - the clean, primary gate;
 *   - the SendWorker re-checks pre-send and DEFERS rather than hard-fails,
 *     so mail enqueued while the gate was off (or before records lapsed)
 *     recovers the moment the records appear.
 *
 * MTA_DNS_GATE=0 is the reversible switch. No live senders exist (an
 * MTA-connected send has never been exercised end to end), so the default is
 * the hard gate the decision asks for - it breaks nobody.
 */

const db = require('../db');
const config = require('../config');
const log = require('../logger');
// dns-verify is a vendored copy of @rutba/mail-dns (consumer/packages/mail-dns):
// one definition of "the records are right" across the estate, presence-only
// on DKIM here because this relay never holds the sender's signing key.
const { verifySendingDomain } = require('../lib/dns-verify');

const domainOf = (address) => String(address || '').split('@')[1]?.toLowerCase() || '';

async function getRow(domain) {
  const rows = await db.query(`SELECT * FROM sender_domain_dns WHERE domain = ?`, [domain]);
  return rows[0] || null;
}

async function upsertVerdict(domain, selector, verdict) {
  const status = verdict.ok ? 'verified' : 'failed';
  const lastError = verdict.ok ? null : `missing: ${verdict.missing.join('; ')}`;
  await db.query(
    `INSERT INTO sender_domain_dns
       (domain, dkim_selector, status, spf_ok, dkim_ok, dmarc_ok, last_error, last_checked_at)
     VALUES (?,?,?,?,?,?,?, NOW())
     ON DUPLICATE KEY UPDATE
       dkim_selector = VALUES(dkim_selector),
       status = VALUES(status),
       spf_ok = VALUES(spf_ok),
       dkim_ok = VALUES(dkim_ok),
       dmarc_ok = VALUES(dmarc_ok),
       last_error = VALUES(last_error),
       last_checked_at = NOW()`,
    [domain, selector, status, verdict.spfOk ? 1 : 0, verdict.dkimOk ? 1 : 0, verdict.dmarcOk ? 1 : 0, lastError]
  );
  return getRow(domain);
}

const ageSeconds = (row) =>
  row?.last_checked_at ? (Date.now() - new Date(row.last_checked_at).getTime()) / 1000 : Infinity;

/**
 * Verify (from cache or live DNS) that a sender's domain may relay.
 * Returns { ok, domain, missing?, row } and never throws on DNS trouble -
 * an unreachable resolver reads as unverified with the reason recorded,
 * because "we could not check" must not become "therefore send".
 */
async function ensureVerified(sender, { resolver, force = false } = {}) {
  if (!config.dnsGate.enabled) return { ok: true, domain: domainOf(sender.address), gated: false };

  const domain = domainOf(sender.address);
  if (!domain) return { ok: false, domain: '', missing: ['a parseable sender domain'] };

  const selector = sender.dkimSelector || sender.dkim_selector || config.dnsGate.defaultSelector;
  let row = await getRow(domain);

  const fresh =
    row &&
    !force &&
    row.dkim_selector === selector &&
    ageSeconds(row) < (row.status === 'verified' ? config.dnsGate.recheckSeconds : config.dnsGate.failRetrySeconds);

  if (!fresh) {
    try {
      const verdict = await verifySendingDomain(domain, { selector, ...(resolver ? { resolver } : {}) });
      row = await upsertVerdict(domain, selector, verdict);
    } catch (e) {
      log.error(`[dns-gate] ${domain} check failed: ${e.message}`);
      if (!row) {
        return { ok: false, domain, missing: [`DNS could not be checked (${e.message})`] };
      }
      // Keep serving the last stored verdict when DNS itself is unreachable.
    }
  }

  if (row.status === 'verified') return { ok: true, domain, row };
  const missing = [];
  if (!row.spf_ok) missing.push('SPF');
  if (!row.dkim_ok) missing.push(`DKIM (selector: ${row.dkim_selector})`);
  return { ok: false, domain, missing, row };
}

module.exports = { ensureVerified, getRow, domainOf };
