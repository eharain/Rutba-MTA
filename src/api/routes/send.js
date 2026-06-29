'use strict';

/**
 * /v1/send       — single message (default class: transactional)
 * /v1/send/batch — templated batch (default class: marketing)
 */

const express = require('express');
const { requireTrustToken } = require('../auth');
const messagesSvc = require('../../services/messages');
const batchesSvc = require('../../services/batches');
const suppression = require('../../services/suppression');
const actionsSvc = require('../../services/actions');
const sendersSvc = require('../../services/senders');
const { isValidEmail, normalizeAddress } = require('../../lib/addresses');
const { render } = require('../../lib/template');
const { normalizeClass } = require('../../lib/msgclass');

const router = express.Router();

// POST /v1/send  — single message
router.post('/send', requireTrustToken, async (req, res) => {
  try {
    const b = req.body || {};
    const to = normalizeAddress(b.to);
    if (!isValidEmail(to)) return res.status(400).json({ error: 'invalid recipient' });

    const cls = normalizeClass(b.class || 'transactional');
    const sup = await suppression.isSuppressed(req.sender.uuid, to);
    if (sup) {
      await messagesSvc.createDroppedEvent({
        senderId: await senderIdFromUuid(req.sender.uuid),
        address: to, reason: `suppression:${sup.reason}`,
      });
      return res.json({ status: 'dropped', reason: sup.reason });
    }

    const data = b.data && typeof b.data === 'object' ? b.data : null;
    const subject = data ? render(b.subject, data) : (b.subject || '');
    let html = data ? render(b.html, data) : (b.html || null);
    let text = data ? render(b.text, data) : (b.text || null);

    const senderId = await senderIdFromUuid(req.sender.uuid);

    // Create the row first so we have the id for action tokens.
    const { id, uuid } = await messagesSvc.createQueued({
      senderId,
      msgClass: cls,
      from: req.sender.address,
      replyTo: b.replyTo || req.sender.replyTo,
      to,
      subject, html, text,
      headers: b.headers,
      scheduledAt: b.scheduledAt ? new Date(b.scheduledAt) : null,
    });

    // Actions: if any, generate tokens, re-render subject/html/text with them.
    if (Array.isArray(b.actions) && b.actions.length) {
      const urlMap = await actionsSvc.createForMessage({
        messageId: id, messageUuid: uuid, senderId, actions: b.actions,
      });
      // Re-render with the action URLs merged into the data context, then
      // update the outbox row's subject/html/text.
      const ctx = Object.assign({}, data || {}, urlMap);
      const subject2 = render(b.subject || subject, ctx);
      const html2 = render(b.html || html, ctx);
      const text2 = render(b.text || text, ctx);
      await require('../../db').query(
        `UPDATE outbox SET subject = ?, html = ?, body_text = ? WHERE id = ?`,
        [subject2, html2, text2, id]
      );
    }

    res.status(202).json({ status: 'queued', uuid });
  } catch (e) {
    res.status(500).json({ error: 'send failed', message: e.message });
  }
});

// POST /v1/send/batch
router.post('/send/batch', requireTrustToken, async (req, res) => {
  try {
    const b = req.body || {};
    if (!Array.isArray(b.recipients) || !b.recipients.length) {
      return res.status(400).json({ error: 'recipients required' });
    }
    // We need the sender row (id) — pass via a quick lookup.
    const senderId = await senderIdFromUuid(req.sender.uuid);
    const senderWithId = { ...req.sender, id: senderId };
    const result = await batchesSvc.create({
      sender: senderWithId,
      subject: b.subject,
      html: b.html || b.template_html,
      text: b.text || b.template_text,
      recipients: b.recipients,
      actions: b.actions || [],
      msgClass: b.class || 'marketing',
    });
    res.status(202).json({
      status: 'queued',
      batch_uuid: result.uuid,
      total: result.total,
      queued: result.queued,
      dropped: result.dropped,
    });
  } catch (e) {
    res.status(500).json({ error: 'batch failed', message: e.message });
  }
});

// Helper: senderIdFromUuid. Cached per-request to avoid extra DB hits.
const senderIdCache = new Map();
async function senderIdFromUuid(uuid) {
  if (senderIdCache.has(uuid)) return senderIdCache.get(uuid);
  const rows = await require('../../db').query(
    `SELECT id FROM sender WHERE uuid = ? LIMIT 1`, [uuid]
  );
  const id = rows[0] ? rows[0].id : null;
  if (id) senderIdCache.set(uuid, id);
  return id;
}

module.exports = router;
