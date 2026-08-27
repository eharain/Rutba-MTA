import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { checkSpf, checkDkim, checkDmarc, verifySendingDomain } = require('../src/lib/dns-verify.js');

/**
 * src/lib/dns-verify.js is a vendored copy of @rutba/mail-dns, which the
 * consumer repo owns and tests more broadly (hosting verdicts, DKIM key
 * match). These tests stay here anyway: they are what a standalone clone of
 * this repo can run, and they pin the behaviour the MTA depends on -
 * SPF + DKIM block, no MX is asked, and DKIM is checked for PRESENCE only
 * because this relay never holds the sender's signing key.
 */

/** A resolver pinned to fixtures instead of the internet. */
function resolverWith(map) {
  return {
    resolveTxt: async (name) => {
      if (!(name in map)) {
        const e = new Error(`queryTxt ENOTFOUND ${name}`);
        e.code = 'ENOTFOUND';
        throw e;
      }
      return map[name];
    },
  };
}

const GOOD = resolverWith({
  'good.example': [['v=spf1 include:_spf.provider.example ~all']],
  'default._domainkey.good.example': [['v=DKIM1; k=rsa; ', 'p=MIGfMA0GCSq']],
  '_dmarc.good.example': [['v=DMARC1; p=quarantine']],
});

test('a domain with SPF + DKIM at the named selector passes', async () => {
  const verdict = await verifySendingDomain('good.example', { selector: 'default', resolver: GOOD });
  assert.equal(verdict.ok, true, JSON.stringify(verdict.missing));
  assert.equal(verdict.dmarcOk, true);
});

test('missing SPF blocks, and says so', async () => {
  const resolver = resolverWith({
    'nospf.example': [['some-verification=abc']],
    'default._domainkey.nospf.example': [['v=DKIM1; p=KEY']],
    '_dmarc.nospf.example': [],
  });
  const verdict = await verifySendingDomain('nospf.example', { selector: 'default', resolver });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.missing.length, 1);
  assert.match(verdict.missing[0], /SPF/);
});

test('missing DKIM at the NAMED selector blocks even when another selector has a key', async () => {
  const resolver = resolverWith({
    'wrongsel.example': [['v=spf1 mx -all']],
    'other._domainkey.wrongsel.example': [['v=DKIM1; p=KEY']],
    '_dmarc.wrongsel.example': [],
  });
  const verdict = await verifySendingDomain('wrongsel.example', { selector: 'default', resolver });
  assert.equal(verdict.ok, false);
  assert.match(verdict.missing[0], /default\._domainkey\.wrongsel\.example/);
});

test('two SPF records are a fault, not a pass (RFC 7208 permerror)', async () => {
  const spf = await checkSpf('multi.example', {
    resolver: resolverWith({ 'multi.example': [['v=spf1 a -all'], ['v=spf1 mx -all']] }),
  });
  assert.equal(spf.ok, false);
  assert.match(spf.missing, /exactly one/);
});

test('a DKIM record split across TXT chunks still counts', async () => {
  const dkim = await checkDkim('chunked.example', {
    selector: 'default',
    resolver: resolverWith({
      'default._domainkey.chunked.example': [['v=DKIM1; k=rsa; p=AAAA', 'BBBBCCCC']],
    }),
  });
  assert.equal(dkim.ok, true);
});

test('an empty DKIM record (p= with no key, a revoked key) does not pass', async () => {
  const dkim = await checkDkim('revoked.example', {
    selector: 'default',
    resolver: resolverWith({
      'default._domainkey.revoked.example': [['v=DKIM1; p=']],
    }),
  });
  assert.equal(dkim.ok, false);
});

test('the sending verdict asks for presence, never a key match', async () => {
  // The shared checks can match a key; this relay must not, because it never
  // holds one. If verifySendingDomain ever starts passing expectedKey, a
  // sender whose key we cannot know would be refused relay - this pins that.
  const resolver = resolverWith({
    'anykey.example': [['v=spf1 mx -all']],
    'default._domainkey.anykey.example': [['v=DKIM1; k=rsa; p=AKEYWEHAVENEVERSEEN']],
    '_dmarc.anykey.example': [],
  });
  const verdict = await verifySendingDomain('anykey.example', { selector: 'default', resolver });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.dkimOk, true);
});

test('DMARC is reported but never blocks', async () => {
  const resolver = resolverWith({
    'nodmarc.example': [['v=spf1 mx -all']],
    'default._domainkey.nodmarc.example': [['v=DKIM1; p=KEY']],
    '_dmarc.nodmarc.example': [],
  });
  const verdict = await verifySendingDomain('nodmarc.example', { selector: 'default', resolver });
  assert.equal(verdict.ok, true);
  assert.equal(verdict.dmarcOk, false);

  const dmarc = await checkDmarc('nodmarc.example', { resolver });
  assert.equal(dmarc.advisory, true);
});

test('NXDOMAIN is a finding, not an exception', async () => {
  const verdict = await verifySendingDomain('gone.example', { selector: 'default', resolver: resolverWith({}) });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.missing.length, 2);
});
