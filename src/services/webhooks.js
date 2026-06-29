'use strict';

/**
 * Outbound webhook dispatcher.
 *
 * Every "interesting" event (sent / bounced / deferred / failed /
 * action_clicked / unsubscribed / batch_complete) is enqueued as a
 * `webhook_delivery` row. A background tick drains the queue, POSTs the
 * payload to the sender's `webhook_url`, and retries on transient failure.
 *
 * Payloads are signed with `X-Mailer-Signature: sha256=<hex>` using the
 * sender's `webhook_secret` so the receiving app can verify authenticity.
 */

const crypto = require('crypto');
const db = require('../db');
const config = require('../config');
const log = require('../logger');
const { nextDelaySeconds } = require('../lib/backoff');

async function enqueue({ senderId, eventType, payload, messageId = null, batchId = null }) {
  await db.query(
    `INSERT INTO webhook_delivery
      (sender_id, message_id, batch_id, event_type, payload, status, next_attempt_at)
     VALUES (?,?,?,?,?, 'pending', NOW())`,
    [senderId, messageId, batchId, eventType, JSON.stringify(payload)]
  );
}

async function selectDue({ now = new Date(), limit = 25 } = {}) {
  return db.query(
    `SELECT w.*, s.webhook_url, s.webhook_secret
       FROM webhook_delivery w
       JOIN sender s ON s.id = w.sender_id
      WHERE w.status = 'pending'
        AND (w.next_attempt_at IS NULL OR w.next_attempt_at <= ?)
        AND s.webhook_url IS NOT NULL
      ORDER BY w.id ASC LIMIT ${Number(limit)}`,
    [now]
  );
}

function signPayload(secret, body) {
  if (!secret) return null;
  return 'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');
}

async function deliverOne(row) {
  const body = typeof row.payload === 'string' ? row.payload : JSON.stringify(row.payload);
  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': 'Rutba-MTA/1',
    'X-Mailer-Event': row.event_type,
    'X-Mailer-Delivery': String(row.id),
  };
  const sig = signPayload(row.webhook_secret, body);
  if (sig) headers['X-Mailer-Signature'] = sig;

  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), config.webhook.timeoutMs);
  try {
    const res = await fetch(row.webhook_url, { method: 'POST', headers, body, signal: ac.signal });
    if (res.status >= 200 && res.status < 300) {
      await db.query(
        `UPDATE webhook_delivery SET status = 'delivered', delivered_at = NOW(),
                last_status_code = ?, last_error = NULL WHERE id = ?`,
        [res.status, row.id]
      );
      return true;
    }
    return scheduleRetry(row, res.status, `HTTP ${res.status}`);
  } catch (e) {
    return scheduleRetry(row, null, e.message || 'fetch error');
  } finally {
    clearTimeout(t);
  }
}

async function scheduleRetry(row, statusCode, errMessage) {
  const attempts = Number(row.attempts) + 1;
  const delay = nextDelaySeconds(attempts);
  if (delay == null || attempts >= config.webhook.maxAttempts) {
    await db.query(
      `UPDATE webhook_delivery SET status = 'failed', attempts = ?,
              last_status_code = ?, last_error = ? WHERE id = ?`,
      [attempts, statusCode, String(errMessage).slice(0, 1000), row.id]
    );
    log.warn(`[webhook] delivery #${row.id} permanently failed: ${errMessage}`);
    return false;
  }
  const next = new Date(Date.now() + delay * 1000);
  await db.query(
    `UPDATE webhook_delivery SET attempts = ?, next_attempt_at = ?,
            last_status_code = ?, last_error = ? WHERE id = ?`,
    [attempts, next, statusCode, String(errMessage).slice(0, 1000), row.id]
  );
  return false;
}

module.exports = { enqueue, selectDue, deliverOne };
