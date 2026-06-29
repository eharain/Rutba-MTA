'use strict';

/**
 * Public (unauthenticated) endpoints — action interception, unsubscribe, health.
 *
 * Action: GET /action/:token
 *   1. Verify HMAC.
 *   2. Load row; reject if expired or already-clicked (idempotent).
 *   3. Record click event + enqueue webhook.
 *   4. 302 → registered redirect_url.
 *
 * Unsubscribe: GET /unsubscribe/:token (renders confirmation page)
 *              POST /unsubscribe/:token (RFC 8058 one-click)
 *   Suppresses the recipient address for THIS sender only.
 */

const express = require('express');
const config = require('../../config');
const log = require('../../logger');
const db = require('../../db');
const { verify } = require('../../lib/tokens');
const actionsSvc = require('../../services/actions');
const suppression = require('../../services/suppression');
const messages = require('../../services/messages');
const webhooks = require('../../services/webhooks');

const router = express.Router();

router.get('/health', async (req, res) => {
  try {
    await db.ping();
    res.json({ status: 'ok' });
  } catch (e) {
    res.status(500).json({ status: 'down', error: e.message });
  }
});

// Action interception.
router.get('/action/:token', async (req, res) => {
  const v = verify(config.secrets.hmac, req.params.token);
  if (v.error) return res.status(v.error === 'expired' ? 410 : 400).json({ error: v.error });
  if (v.kind !== 'action') return res.status(400).json({ error: 'wrong token kind' });

  const row = await actionsSvc.findByToken(req.params.token);
  if (!row) return res.status(404).json({ error: 'action not found' });

  // Idempotency: first-click fires the event + webhook; subsequent clicks
  // still redirect (recipient may have hit the link twice) but don't re-fire.
  const wasFirstClick = !row.clicked_at;
  await actionsSvc.markClicked(row.id, {
    ip: req.ip,
    userAgent: req.get('user-agent'),
  });
  if (wasFirstClick) {
    await messages.logEvent({
      messageId: row.message_id, messageUuid: row.message_uuid, senderId: row.sender_id,
      type: 'action_clicked',
      extra: { key: row.action_key, type: row.action_type },
    });
    try {
      await webhooks.enqueue({
        senderId: row.sender_id,
        messageId: row.message_id,
        eventType: 'action_clicked',
        payload: {
          event: 'action_clicked',
          message_uuid: row.message_uuid,
          action_key: row.action_key,
          action_type: row.action_type,
          redirect_url: row.redirect_url,
          ip: req.ip,
          occurred_at: new Date().toISOString(),
        },
      });
    } catch (e) { log.warn('[action] webhook enqueue', e.message); }
  }

  res.redirect(302, row.redirect_url);
});

async function handleUnsubscribe(req, res, viaPost) {
  const v = verify(config.secrets.hmac, req.params.token);
  if (v.error) return res.status(v.error === 'expired' ? 410 : 400).json({ error: v.error });
  if (v.kind !== 'unsubscribe') return res.status(400).json({ error: 'wrong token kind' });

  // The token's id is the outbox row id.
  const message = await messages.findByIdOrUuid(String(v.id));
  if (!message) return res.status(404).json({ error: 'message not found' });

  // Look up the sender uuid for scope.
  const senderRows = await db.query(`SELECT uuid FROM sender WHERE id = ?`, [message.sender_id]);
  const senderUuid = senderRows[0] && senderRows[0].uuid;
  if (!senderUuid) return res.status(404).json({ error: 'sender not found' });

  // Idempotency: re-clicks (forwarded links, browser back-button, mail-
  // client preview prefetch) must not re-emit events or webhooks.
  const wasAlready = !!message.unsubscribed_at;
  await suppression.suppress({
    address: message.to_addr,
    scope: senderUuid,
    reason: 'unsubscribe',
    sourceUuid: message.uuid,
  });
  if (!wasAlready) {
    await db.query(`UPDATE outbox SET unsubscribed_at = NOW() WHERE id = ?`, [message.id]);
    await messages.logEvent({
      messageId: message.id, messageUuid: message.uuid, senderId: message.sender_id,
      type: 'unsubscribed', reason: viaPost ? 'one-click' : 'web',
    });
    try {
      await webhooks.enqueue({
        senderId: message.sender_id,
        messageId: message.id,
        eventType: 'unsubscribed',
        payload: {
          event: 'unsubscribed',
          message_uuid: message.uuid,
          address: message.to_addr,
          scope: senderUuid,
          via: viaPost ? 'one-click' : 'web',
          occurred_at: new Date().toISOString(),
        },
      });
    } catch (e) { log.warn('[unsub] webhook enqueue', e.message); }
  }

  if (viaPost) return res.status(200).json({ status: 'unsubscribed' });
  res.type('html').send(`<!doctype html><html><body style="font-family:sans-serif;max-width:480px;margin:48px auto;padding:24px">
    <h1>Unsubscribed</h1>
    <p>You will no longer receive marketing email from this sender.</p>
  </body></html>`);
}

router.get('/unsubscribe/:token', (req, res) => handleUnsubscribe(req, res, false));
router.post('/unsubscribe/:token', (req, res) => handleUnsubscribe(req, res, true));

module.exports = router;
