'use strict';

/**
 * Templated batch send.
 *
 * Flow:
 *   1. Create the `batch` row (template + class).
 *   2. For every recipient:
 *      a. Format-validate the address.
 *      b. Suppression check; suppressed → 'dropped' event, exclude from queue.
 *      c. Create the outbox row (subject/html/text are stored as TEMPLATES;
 *         the worker expands them at send time so per-recipient action URLs
 *         can be injected).
 *      d. Generate any per-recipient action tokens.
 *   3. Return { batch_uuid, total, queued, dropped }.
 *
 * Templates are stored on the batch row so updates to the batch (future) and
 * audit are easy. The outbox row holds a JSON `headers` blob with `_data`
 * (per-recipient substitution data) and `_actions` (the resolved action URLs).
 */

const { randomUUID } = require('crypto');
const db = require('../db');
const { normalizeAddress, domainOf, isValidEmail } = require('../lib/addresses');
const { normalizeClass } = require('../lib/msgclass');
const { maxAttempts } = require('../lib/backoff');
const suppression = require('./suppression');
const messages = require('./messages');
const actions = require('./actions');

async function create({ sender, subject, html, text, recipients, actions: actionDefs = [], msgClass = 'marketing' }) {
  if (!Array.isArray(recipients) || !recipients.length) {
    throw new Error('recipients must be a non-empty array');
  }
  const uuid = randomUUID();
  const cls = normalizeClass(msgClass);

  const batchRes = await db.query(
    `INSERT INTO batch
      (uuid, sender_id, msg_class, subject_template, html_template, text_template, total)
     VALUES (?,?,?,?,?,?,?)`,
    [uuid, sender.id, cls, subject || null, html || null, text || null, recipients.length]
  );
  const batchId = batchRes.insertId;

  let queued = 0;
  let dropped = 0;
  const errors = [];

  for (const rec of recipients) {
    const to = normalizeAddress(rec && rec.to);
    const data = (rec && typeof rec.data === 'object' && rec.data) || {};
    if (!isValidEmail(to)) {
      dropped += 1;
      errors.push({ to, reason: 'invalid_address' });
      await messages.createDroppedEvent({ senderId: sender.id, address: to || '(empty)', reason: 'invalid_address' });
      continue;
    }
    const sup = await suppression.isSuppressed(sender.uuid, to);
    if (sup) {
      dropped += 1;
      await messages.createDroppedEvent({ senderId: sender.id, address: to, reason: `suppression:${sup.reason}` });
      continue;
    }

    // Create the outbox row holding the TEMPLATE strings (not yet rendered)
    // plus the per-recipient data + actions in headers._data / headers._actions.
    // The worker resolves them in-process before SMTP.
    const msgUuid = randomUUID();
    const insertRes = await db.query(
      `INSERT INTO outbox
        (uuid, sender_id, batch_id, msg_class, from_addr, reply_to, to_addr, to_domain,
         subject, html, body_text, headers, status, attempts, max_attempts, next_attempt_at)
       VALUES (?,?,?,?, ?,?,?,?, ?,?,?,?, 'queued', 0, ?, NOW())`,
      [
        msgUuid, sender.id, batchId, cls,
        sender.address, sender.replyTo || null, to, domainOf(to),
        subject || null, html || null, text || null,
        JSON.stringify({ _data: data, _template: true }),
        maxAttempts(),
      ]
    );
    const messageId = insertRes.insertId;

    if (Array.isArray(actionDefs) && actionDefs.length) {
      const urlMap = await actions.createForMessage({
        messageId, messageUuid: msgUuid, senderId: sender.id, actions: actionDefs,
      });
      // Merge action urls into headers._actions so the worker can include them
      // in template data.
      await db.query(
        `UPDATE outbox SET headers = JSON_SET(headers, '$._actions', CAST(? AS JSON)) WHERE id = ?`,
        [JSON.stringify(urlMap), messageId]
      );
    }

    await messages.logEvent({ messageId, messageUuid: msgUuid, senderId: sender.id, type: 'queued' });
    queued += 1;
  }

  await db.query(
    `UPDATE batch SET queued = ?, dropped = ? WHERE id = ?`,
    [queued, dropped, batchId]
  );

  return { uuid, id: batchId, total: recipients.length, queued, dropped, errors };
}

async function findByUuid(uuid) {
  const rows = await db.query(`SELECT * FROM batch WHERE uuid = ? LIMIT 1`, [uuid]);
  return rows[0] || null;
}

async function findByIdOrUuid(idOrUuid) {
  const isUuid = typeof idOrUuid === 'string' && idOrUuid.length === 36;
  const rows = await db.query(
    `SELECT * FROM batch WHERE ${isUuid ? 'uuid' : 'id'} = ? LIMIT 1`,
    [idOrUuid]
  );
  return rows[0] || null;
}

async function listForSender(senderId, { limit = 50, offset = 0 } = {}) {
  return db.query(
    `SELECT id, uuid, msg_class, total, queued, dropped, completed_at, created_at
       FROM batch WHERE sender_id = ?
      ORDER BY id DESC LIMIT ${Number(limit)} OFFSET ${Number(offset)}`,
    [senderId]
  );
}

/**
 * Aggregate delivery report for a batch. Counts the outbox rows by terminal
 * status; merges in action click counts and unsubscribed count.
 */
async function report(batchId) {
  const batch = await findByIdOrUuid(batchId);
  if (!batch) return null;
  const [statusRows] = await Promise.all([
    db.query(
      `SELECT status, COUNT(*) AS n FROM outbox WHERE batch_id = ? GROUP BY status`,
      [batch.id]
    ),
  ]);
  const counts = { queued: 0, sending: 0, sent: 0, deferred: 0, bounced: 0, failed: 0, dropped: 0 };
  for (const r of statusRows) counts[r.status] = Number(r.n);
  const total = batch.total;
  const pending = counts.queued + counts.sending + counts.deferred;
  const unsubRow = await db.query(
    `SELECT COUNT(*) AS n FROM outbox WHERE batch_id = ? AND unsubscribed_at IS NOT NULL`,
    [batch.id]
  );
  const actionClicks = await actions.summaryForBatch(batch.id);

  // bounced split: query bounce_type via event rows.
  const bRows = await db.query(
    `SELECT bounce_type, COUNT(*) AS n
       FROM event e
       JOIN outbox o ON o.id = e.message_id
      WHERE o.batch_id = ? AND e.type = 'bounced'
      GROUP BY bounce_type`,
    [batch.id]
  );
  let bouncedHard = 0; let bouncedSoft = 0;
  for (const r of bRows) {
    if (r.bounce_type === 'hard') bouncedHard = Number(r.n);
    if (r.bounce_type === 'soft') bouncedSoft = Number(r.n);
  }

  // Add suppression-dropped (recorded on batch.dropped) to dropped count if not
  // already captured (suppression drops never get an outbox row).
  const dropped = Math.max(counts.dropped, Number(batch.dropped) || 0);
  const complete = pending === 0;

  // Mark batch complete on the first observation.
  if (complete && !batch.completed_at) {
    await db.query(`UPDATE batch SET completed_at = NOW() WHERE id = ?`, [batch.id]);
  }
  return {
    batch_uuid: batch.uuid,
    class: batch.msg_class,
    total, queued: counts.queued, sent: counts.sent,
    bounced_hard: bouncedHard, bounced_soft: bouncedSoft,
    suppressed: dropped, failed: counts.failed, pending,
    actions_clicked: actionClicks,
    unsubscribed: Number(unsubRow[0].n) || 0,
    complete,
  };
}

module.exports = { create, findByUuid, findByIdOrUuid, listForSender, report };
