'use strict';

const express = require('express');
const { requireTrustToken } = require('../auth');
const suppressionSvc = require('../../services/suppression');

const router = express.Router();

router.get('/', requireTrustToken, async (req, res) => {
  const rows = await suppressionSvc.listForSender(req.sender.uuid, {
    address: req.query.address,
    limit: Math.min(500, Number(req.query.limit) || 50),
    offset: Number(req.query.offset) || 0,
  });
  res.json({ suppressions: rows });
});

router.post('/', requireTrustToken, async (req, res) => {
  const b = req.body || {};
  if (!b.address) return res.status(400).json({ error: 'address required' });
  let scope = b.scope === 'global' ? 'global' : req.sender.uuid;
  if (scope === 'global' && !req.sender.isAdmin) {
    return res.status(403).json({ error: 'global scope is admin-only' });
  }
  await suppressionSvc.suppress({
    address: b.address, scope, reason: b.reason || 'manual_block', note: b.note,
  });
  res.status(201).json({ status: 'suppressed' });
});

router.delete('/:address', requireTrustToken, async (req, res) => {
  let scope = (req.query && req.query.scope) === 'global' ? 'global' : req.sender.uuid;
  if (scope === 'global' && !req.sender.isAdmin) {
    return res.status(403).json({ error: 'global scope is admin-only' });
  }
  await suppressionSvc.unsuppress(req.params.address, scope);
  res.json({ status: 'cleared' });
});

module.exports = router;
