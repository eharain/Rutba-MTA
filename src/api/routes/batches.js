'use strict';

const express = require('express');
const { requireTrustToken } = require('../auth');
const batchesSvc = require('../../services/batches');

const router = express.Router();

router.get('/', requireTrustToken, async (req, res) => {
  const rows = await batchesSvc.listForSender(req.sender._id, {
    limit: Math.min(500, Number(req.query.limit) || 50),
    offset: Number(req.query.offset) || 0,
  });
  res.json({ batches: rows });
});

router.get('/:idOrUuid', requireTrustToken, async (req, res) => {
  const batch = await batchesSvc.findByIdOrUuid(req.params.idOrUuid);
  if (!batch) return res.status(404).json({ error: 'not found' });
  if (batch.sender_id !== req.sender._id && !req.sender.isAdmin) {
    return res.status(403).json({ error: 'forbidden' });
  }
  res.json({ batch });
});

router.get('/:idOrUuid/report', requireTrustToken, async (req, res) => {
  const batch = await batchesSvc.findByIdOrUuid(req.params.idOrUuid);
  if (!batch) return res.status(404).json({ error: 'not found' });
  if (batch.sender_id !== req.sender._id && !req.sender.isAdmin) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const report = await batchesSvc.report(batch.id);
  res.json(report);
});

module.exports = router;
