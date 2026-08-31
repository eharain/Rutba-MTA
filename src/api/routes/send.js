'use strict';

/**
 * /v1/send       — single message (default class: transactional)
 * /v1/send/batch — templated batch (default class: marketing)
 */

const express = require('express');
const { requireTrustToken } = require('../auth');
const dnsGate = require('../../services/dns-gate');
const messagesSvc = require('../../services/messages');
const batchesSvc = require('../../services/batches');
const suppression = require('../../services/suppression');
const actionsSvc = require('../../services/actions');
const db = require('../../db');
const { isValidEmail, normalizeAddress } = require('../../lib/addresses');
const { render } = require('../../lib/template');
const { normalizeClass } = require('../../lib/msgclass');

const router = express.Router();

/**
 * The DNS gate, at the front door: no SPF + DKIM at the sender's domain, no
 * relay - refused before any outbox row exists (422, machine-readable), per
 * the owner decision of 2026-08-25. The worker re-checks pre-send and defers,
 * so anything already queued recovers when the records appear.
 */
async function requireVerifiedDomain(req, res, next) {
  try {
    const verdict = await dnsGate.ensureVerified(req.sender);
    if (verdict.ok) return next();
    return res.status(422).json({
      error: 'domain_dns_unverified',
      domain: verdict.domain,
      missing: verdict.missing,
      message: `Sending from ${verdict.domain} requires its DNS records first - missing: ${verdict.missing.join(', ')}. ` +
        'Publish them, then retry (or POST /v1/dns/' + verdict.domain + '/verify to re-check now).',
    });
  } catch (e) {
    return res.status(500).json({ error: 'dns gate failed', message: e.message });
  }
}

// POST /v1/send  — single message
router.post('/send', requireTrustToken, requireVerifiedDomain, async (req, res) => {
  try {
    const b = req.body || {};
    const to = normalizeAddress(b.to);
    if (!isValidEmail(to)) return res.status(400).json({ error: 'invalid recipient' });

    const senderId = req.sender._id;
    const cls = normalizeClass(b.class || 'transactional');
    const sup = await suppression.isSuppressed(req.sender.uuid, to);
    if (sup) {
      await messagesSvc.createDroppedEvent({ senderId, address: to, reason: `suppression:${sup.reason}` });
      return res.json({ status: 'dropped', reason: sup.reason });
    }

    const data = b.data && typeof b.data === 'object' ? b.data : null;
    const subject = data ? render(b.subject, data) : (b.subject || '');
    const html = data ? render(b.html, data) : (b.html || null);
    const text = data ? render(b.text, data) : (b.text || null);

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
      // `{ method, content }` — an iCalendar object to carry as a
      // text/calendar part. Never rendered as a template: a {{token}} inside a
      // UID or DTSTART would be substituted into nonsense.
      calendar: b.calendar && b.calendar.content
        ? { method: b.calendar.method, content: b.calendar.content }
        : null,
    });

    // Actions: if any, generate tokens, re-render subject/html/text with them.
    if (Array.isArray(b.actions) && b.actions.length) {
      const urlMap = await actionsSvc.createForMessage({
        messageId: id, messageUuid: uuid, senderId, actions: b.actions,
      });
      const ctx = Object.assign({}, data || {}, urlMap);
      const subject2 = render(b.subject || subject, ctx);
      const html2 = render(b.html || html, ctx);
      const text2 = render(b.text || text, ctx);
      await db.query(
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
router.post('/send/batch', requireTrustToken, requireVerifiedDomain, async (req, res) => {
  try {
    const b = req.body || {};
    if (!Array.isArray(b.recipients) || !b.recipients.length) {
      return res.status(400).json({ error: 'recipients required' });
    }
    const senderWithId = { ...req.sender, id: req.sender._id };
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

module.exports = router;
