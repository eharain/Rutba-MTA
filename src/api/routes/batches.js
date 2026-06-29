'use strict';

const express = require('express');
const { requireTrustToken } = require('../auth');
const batchesSvc = require('../../services/batches');
const db = require('../../db');

const router = express.Router();

router.get('/', requireTrustToken, async (req, res) => {
  const senderIdRow = await db.query(`SELECT id FROM sender WHERE uuid = ?`, [req.sender.uuid]);
  if (!senderIdRow[0]) return res.status(404).json({ error: 'sender not found' });
  const rows = await batchesSvc.listForSender(senderIdRow[0].id, {
    limit: Math.min(500, Number(req.query.limit) || 50),
    offset: Number(req.query.offset) || 0,
  });
  res.json({ batches: rows });
});

router.get('/:idOrUuid', requireTrustToken, async (req, res) => {
  const batch = await batchesSvc.findByIdOrUuid(req.params.idOrUuid);
  if (!batch) return res.status(404).json({ error: 'not found' });
  // Tenant isolation.
  if (!req.sender.isAdmin) {
    const own = await db.query(`SELECT id FROM sender WHERE uuid = ?`, [req.sender.uuid]);
    if (!own[0] || own[0].id !== batch.sender_id) return res.status(403).json({ error: 'forbidden' });
  }
  res.json({ batch });
});

router.get('/:idOrUuid/report', requireTrustToken, async (req, res) => {
  const batch = await batchesSvc.findByIdOrUuid(req.params.idOrUuid);
  if (!batch) return res.status(404).json({ error: 'not found' });
  if (!req.sender.isAdmin) {
    const own = await db.query(`SELECT id FROM sender WHERE uuid = ?`, [req.sender.uuid]);
    if (!own[0] || own[0].id !== batch.sender_id) return res.status(403).json({ error: 'forbidden' });
  }
  const report = await batchesSvc.report(batch.id);
  res.json(report);
});

module.exports = router;
