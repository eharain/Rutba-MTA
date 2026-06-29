'use strict';

/** Per-domain reputation visibility + admin overrides. */

const express = require('express');
const { requireTrustToken, requireAdmin } = require('../auth');
const domainsSvc = require('../../services/domains');

const router = express.Router();

router.get('/', requireTrustToken, requireAdmin, async (req, res) => {
  const rows = await domainsSvc.listAll({
    limit: Math.min(500, Number(req.query.limit) || 200),
    offset: Number(req.query.offset) || 0,
  });
  res.json({ domains: rows });
});

router.get('/:domain', requireTrustToken, requireAdmin, async (req, res) => {
  const row = await domainsSvc.getOrCreate(req.params.domain);
  res.json({ domain: row });
});

router.put('/:domain', requireTrustToken, requireAdmin, async (req, res) => {
  const b = req.body || {};
  const updated = await domainsSvc.setOverrides(req.params.domain, {
    scoreOverride: b.scoreOverride,
    maxPerMinute: b.maxPerMinute,
    notes: b.notes,
  });
  res.json({ domain: updated });
});

router.post('/:domain/reset', requireTrustToken, requireAdmin, async (req, res) => {
  await domainsSvc.resetCounters(req.params.domain);
  res.json({ status: 'reset' });
});

module.exports = router;
