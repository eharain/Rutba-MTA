'use strict';

/**
 * SENDING-domain DNS verification state - the /v1/dns admin surface for the
 * gate in services/dns-gate.js. (Receiving-domain reputation stays at
 * /v1/domains; the two registries are deliberately separate.)
 *
 * Registration is never gated - only sending is - so a sender can register,
 * read what is missing here, publish records, and force a re-check without
 * waiting out the retry cadence.
 */

const express = require('express');
const { requireTrustToken, requireAdmin } = require('../auth');
const dnsGate = require('../../services/dns-gate');
const db = require('../../db');
const config = require('../../config');

const router = express.Router();

// GET /v1/dns/:domain — the stored verdict.
router.get('/:domain', requireTrustToken, requireAdmin, async (req, res) => {
  const domain = String(req.params.domain || '').toLowerCase();
  const row = await dnsGate.getRow(domain);
  if (!row) return res.status(404).json({ error: 'not checked yet', domain });
  res.json({ domain: row });
});

// POST /v1/dns/:domain/verify — force a live re-check now.
router.post('/:domain/verify', requireTrustToken, requireAdmin, async (req, res) => {
  try {
    const domain = String(req.params.domain || '').toLowerCase();
    // The selector comes from the sender that owns an address on this domain
    // (or the body / the default) so the check looks where the key really is.
    let selector = String(req.body?.dkimSelector || '').trim();
    if (!selector) {
      const rows = await db.query(
        `SELECT dkim_selector FROM sender
          WHERE address LIKE ? AND dkim_selector IS NOT NULL AND status = 'active'
          LIMIT 1`,
        [`%@${domain}`]
      );
      selector = rows[0]?.dkim_selector || config.dnsGate.defaultSelector;
    }
    const verdict = await dnsGate.ensureVerified(
      { address: `probe@${domain}`, dkim_selector: selector },
      { force: true }
    );
    res.json({
      domain: verdict.domain,
      ok: verdict.ok,
      ...(verdict.missing ? { missing: verdict.missing } : {}),
      row: verdict.row || null,
    });
  } catch (e) {
    res.status(500).json({ error: 'verify failed', message: e.message });
  }
});

module.exports = router;
