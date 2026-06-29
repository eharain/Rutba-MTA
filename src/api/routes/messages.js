'use strict';

const express = require('express');
const { requireTrustToken } = require('../auth');
const messagesSvc = require('../../services/messages');

const router = express.Router();

router.get('/', requireTrustToken, async (req, res) => {
  const rows = await messagesSvc.listForSender(req.sender._id, {
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
  if (msg.sender_id !== req.sender._id && !req.sender.isAdmin) {
    return res.status(403).json({ error: 'forbidden' });
  }
  const events = await messagesSvc.listEvents(msg.id);
  res.json({ message: msg, events });
});

module.exports = router;
