'use strict';

/**
 * DNS record checks for SENDING domains - the technical half of "no required
 * records, no relay". Pure lookups, no state; the dns-gate service stores
 * verdicts and owns the recheck cadence.
 *
 * What is checked, and why only this:
 *   SPF   exactly one v=spf1 TXT at the apex (more than one is itself a
 *         fault - RFC 7208 receivers treat multiples as permerror)
 *   DKIM  a v=DKIM1/p= TXT at {selector}._domainkey.{domain}. PRESENCE, not
 *         key match: the MTA relays through the sender's own SMTP server and
 *         never holds the signing key (FUNCTION.md) - it can prove the
 *         sender published *a* key at the selector they named, no more.
 *   DMARC advisory - reported, never blocking.
 *
 * The resolver is injectable so tests pin answers instead of the internet.
 * NXDOMAIN / empty answers are findings ("the record is not there"), never
 * exceptions.
 */

const { promises: realDns } = require('node:dns');

const norm = (d) => String(d || '').trim().toLowerCase().replace(/\.$/, '');

async function txtRecords(resolver, name) {
  try {
    const rows = await resolver.resolveTxt(name);
    return rows.map((chunks) => chunks.join(''));
  } catch (e) {
    if (e && (e.code === 'ENOTFOUND' || e.code === 'ENODATA')) return [];
    throw e;
  }
}

async function checkSpf(domain, { resolver = realDns } = {}) {
  const name = norm(domain);
  if (!name) throw new Error('checkSpf: domain required');
  const all = await txtRecords(resolver, name);
  const spf = all.filter((t) => /^v=spf1(\s|$)/i.test(t.trim()));
  if (spf.length === 1) return { ok: true, observed: spf };
  return {
    ok: false,
    observed: spf,
    missing: spf.length === 0 ? 'SPF (a v=spf1 TXT record)' : 'exactly one SPF record (multiple found)',
  };
}

async function checkDkim(domain, selector, { resolver = realDns } = {}) {
  const name = norm(domain);
  if (!name) throw new Error('checkDkim: domain required');
  const host = `${String(selector || 'default').trim()}._domainkey.${name}`;
  const all = await txtRecords(resolver, host);
  const record = all
    .map((t) => String(t).replace(/["\s]/g, ''))
    .find((t) => /(^|;)v=DKIM1(;|$)/i.test(t) || /(^|;)p=[^;]+/i.test(t));
  if (record && /(^|;)p=[^;]+/i.test(record)) return { ok: true, observed: all };
  return { ok: false, observed: all, missing: `DKIM (a TXT record at ${host})` };
}

async function checkDmarc(domain, { resolver = realDns } = {}) {
  const name = norm(domain);
  if (!name) throw new Error('checkDmarc: domain required');
  const all = await txtRecords(resolver, `_dmarc.${name}`);
  const observed = all.filter((t) => /^v=DMARC1(\s|;|$)/i.test(t.trim()));
  return { ok: observed.length > 0, observed, advisory: true };
}

/**
 * The whole verdict for one sending domain. Blocking = SPF + DKIM; DMARC is
 * reported alongside.
 */
async function verifySendingDomain(domain, selector, { resolver = realDns } = {}) {
  const [spf, dkim, dmarc] = await Promise.all([
    checkSpf(domain, { resolver }),
    checkDkim(domain, selector, { resolver }),
    checkDmarc(domain, { resolver }),
  ]);
  const missing = [spf, dkim].filter((r) => !r.ok).map((r) => r.missing);
  return {
    ok: missing.length === 0,
    missing,
    spfOk: spf.ok,
    dkimOk: dkim.ok,
    dmarcOk: dmarc.ok,
  };
}

module.exports = { checkSpf, checkDkim, checkDmarc, verifySendingDomain };
