'use strict';

/**
 * Sender registration + self-service.
 *
 * Bootstrap UX: the first sender is registered without a token (since none
 * exists yet) and is auto-flagged is_admin. Subsequent registrations require
 * an existing admin's trust token in `X-Trust-Token`.
 */

const express = require('express');
const sendersSvc = require('../../services/senders');
const db = require('../../db');
const { requireTrustToken, requireAdmin } = require('../auth');

const router = express.Router();

async function isFirstSender() {
  const rows = await db.query(`SELECT COUNT(*) AS n FROM sender WHERE status <> 'deleted'`);
  return Number(rows[0].n) === 0;
}

// POST /v1/senders — register a new sender. First call needs no auth and gets
// is_admin = true. After that, only an admin can register additional senders.
router.post('/', async (req, res) => {
  try {
    const first = await isFirstSender();
    if (!first) {
      const adminToken = req.get('X-Trust-Token') || '';
      const caller = await sendersSvc.authenticate(adminToken);
      if (!caller || !caller.isAdmin) return res.status(403).json({ error: 'admin only after bootstrap' });
    }
    const body = req.body || {};
    if (!body.address || !body.smtp) return res.status(400).json({ error: 'address and smtp required' });
    const { sender, trustToken, webhookSecret } = await sendersSvc.register({
      address: body.address,
      displayName: body.displayName,
      replyTo: body.replyTo,
      smtp: body.smtp,
      webhookUrl: body.webhookUrl,
      isAdmin: first ? true : !!body.isAdmin,
    });
    // trustToken is shown ONCE.
    res.status(201).json({ sender: sendersSvc.apiView(sender), trustToken, webhookSecret });
  } catch (e) {
    res.status(500).json({ error: 'register failed', message: e.message });
  }
});

router.get('/me', requireTrustToken, (req, res) => {
  res.json({ sender: sendersSvc.apiView(req.sender) });
});

router.put('/me', requireTrustToken, async (req, res) => {
  try {
    const updated = await sendersSvc.update(req.sender.uuid, req.body || {});
    res.json({ sender: sendersSvc.apiView(updated) });
  } catch (e) {
    res.status(500).json({ error: 'update failed', message: e.message });
  }
});

router.delete('/me', requireTrustToken, async (req, res) => {
  await sendersSvc.softDelete(req.sender.uuid);
  res.json({ status: 'deleted' });
});

router.post('/me/rotate-token', requireTrustToken, async (req, res) => {
  const trustToken = await sendersSvc.rotateToken(req.sender.uuid);
  res.json({ trustToken });
});

router.post('/me/rotate-webhook-secret', requireTrustToken, async (req, res) => {
  const webhookSecret = await sendersSvc.rotateWebhookSecret(req.sender.uuid);
  res.json({ webhookSecret });
});

module.exports = router;
