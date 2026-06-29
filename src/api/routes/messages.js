'use strict';

const express = require('express');
const { requireTrustToken } = require('../auth');
const messagesSvc = require('../../services/messages');
const db = require('../../db');

const router = express.Router();

router.get('/', requireTrustToken, async (req, res) => {
  const senderIdRow = await db.query(`SELECT id FROM sender WHERE uuid = ?`, [req.sender.uuid]);
  if (!senderIdRow[0]) return res.status(404).json({ error: 'sender not found' });
  const rows = await messagesSvc.listForSender(senderIdRow[0].id, {
    status: req.query.status,
    to: req.query.to,
    msgClass: req.query.class,
    limit: Math.min(500, Number(req.query.limit) || 50),
    offset: Number(req.query.offset) || 0,
  });
  res.json({ messages: rows });
});

router.get('/:idOrUuid', requireTrustToken, async (req, res) => {
  const msg = await messagesSvc.findByIdOrUuid(req.params.idOrUuid);
  if (!msg) return res.status(404).json({ error: 'not found' });
  // Tenant isolation: own messages only (unless admin).
  if (msg.sender_id) {
    const row = await db.query(`SELECT uuid FROM sender WHERE id = ?`, [msg.sender_id]);
    const ownerUuid = row[0] && row[0].uuid;
    if (ownerUuid !== req.sender.uuid && !req.sender.isAdmin) {
      return res.status(403).json({ error: 'forbidden' });
    }
  }
  const events = await messagesSvc.listEvents(msg.id);
  res.json({ message: msg, events });
});

module.exports = router;
