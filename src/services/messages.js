'use strict';

/**
 * Single-message create + status transitions.
 *
 * createQueued is the path for both /v1/send (single) and the per-recipient
 * inserts inside a batch send. selectDue / claimSending are how the worker
 * pulls work — claimSending uses an atomic UPDATE so two replicas can't both
 * grab the same row.
 */

const { randomUUID } = require('crypto');
const db = require('../db');
const { normalizeAddress, domainOf } = require('../lib/addresses');
const { normalizeClass } = require('../lib/msgclass');
const { maxAttempts } = require('../lib/backoff');

async function createQueued({
  senderId, batchId = null, msgClass = 'transactional',
  from, replyTo = null, to, subject = null, html = null, text = null,
  headers = null, scheduledAt = null,
}) {
  const uuid = randomUUID();
  const cls = normalizeClass(msgClass);
  const toAddr = normalizeAddress(to);
  const toDomain = domainOf(toAddr);
  const res = await db.query(
    `INSERT INTO outbox
      (uuid, sender_id, batch_id, msg_class, from_addr, reply_to, to_addr, to_domain,
       subject, html, body_text, headers, status, attempts, max_attempts,
       next_attempt_at, scheduled_at)
     VALUES (?,?,?,?, ?,?,?,?, ?,?,?,?, 'queued', 0, ?, ?, ?)`,
    [
      uuid, senderId, batchId, cls, from, replyTo, toAddr, toDomain,
      subject, html, text, headers ? JSON.stringify(headers) : null,
      maxAttempts(), scheduledAt || new Date(), scheduledAt,
    ]
  );
  await logEvent({ messageId: res.insertId, messageUuid: uuid, senderId, type: 'queued' });
  return { id: res.insertId, uuid };
}

/** Record a 'dropped' message (suppression hit at queue time). No outbox row. */
async function createDroppedEvent({ senderId, address, reason }) {
  await logEvent({
    messageId: null, messageUuid: null, senderId,
    type: 'dropped', reason: `${reason}: ${address}`,
  });
}

async function logEvent({ messageId = null, messageUuid = null, senderId = null,
                          type, smtpCode = null, bounceType = null,
                          reason = null, extra = null, raw = null }) {
  await db.query(
    `INSERT INTO event
      (message_id, message_uuid, sender_id, type, smtp_code, bounce_type, reason, extra, raw)
     VALUES (?,?,?,?,?,?,?,?,?)`,
    [
      messageId, messageUuid, senderId, type, smtpCode, bounceType, reason,
      extra ? JSON.stringify(extra) : null, raw,
    ]
  );
}

/**
 * Pull a batch of due messages. Transactional first (so a burst of password-
 * resets always jumps ahead of an in-progress marketing batch).
 */
async function selectDue({ now = new Date(), limit = 50 } = {}) {
  return db.query(
    `SELECT * FROM outbox
      WHERE status IN ('queued','deferred')
        AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
      ORDER BY FIELD(msg_class, 'transactional', 'marketing'),
               next_attempt_at ASC, id ASC
      LIMIT ${Number(limit)}`,
    [now]
  );
}

/**
 * Atomic claim: flip status to 'sending' IFF still in a sendable state. Returns
 * true on success, false if another worker already claimed the row.
 */
async function claimSending(id) {
  const res = await db.query(
    `UPDATE outbox SET status = 'sending', attempts = attempts + 1
      WHERE id = ? AND status IN ('queued','deferred')`,
    [id]
  );
  return res.affectedRows === 1;
}

async function markSent(id, providerMessageId) {
  await db.query(
    `UPDATE outbox SET status = 'sent', sent_at = NOW(), provider_message_id = ?, error = NULL
      WHERE id = ?`,
    [providerMessageId || null, id]
  );
}

async function markDeferred(id, { nextAttemptAt, reason }) {
  await db.query(
    `UPDATE outbox SET status = 'deferred', next_attempt_at = ?, error = ?
      WHERE id = ?`,
    [nextAttemptAt, String(reason || '').slice(0, 1000), id]
  );
}

async function markFailed(id, reason) {
  await db.query(
    `UPDATE outbox SET status = 'failed', error = ? WHERE id = ?`,
    [String(reason || '').slice(0, 1000), id]
  );
}

async function markBounced(id, { reason, smtpCode = null, bounceType = null }) {
  await db.query(
    `UPDATE outbox SET status = 'bounced', error = ? WHERE id = ?`,
    [String(reason || '').slice(0, 1000), id]
  );
  // (event row is the caller's responsibility — they know the raw report)
  return { smtpCode, bounceType };
}

async function findByIdOrUuid(idOrUuid) {
  const isUuid = typeof idOrUuid === 'string' && idOrUuid.length === 36;
  const rows = await db.query(
    `SELECT * FROM outbox WHERE ${isUuid ? 'uuid' : 'id'} = ? LIMIT 1`,
    [idOrUuid]
  );
  return rows[0] || null;
}

async function listEvents(messageId) {
  return db.query(
    `SELECT id, type, smtp_code, bounce_type, reason, extra, occurred_at
       FROM event WHERE message_id = ? ORDER BY id ASC`,
    [messageId]
  );
}

async function listForSender(senderId, { status = null, to = null, msgClass = null, limit = 50, offset = 0 } = {}) {
  const where = ['sender_id = ?'];
  const args = [senderId];
  if (status)    { where.push('status = ?'); args.push(status); }
  if (to)        { where.push('to_addr = ?'); args.push(normalizeAddress(to)); }
  if (msgClass)  { where.push('msg_class = ?'); args.push(normalizeClass(msgClass)); }
  return db.query(
    `SELECT id, uuid, msg_class, from_addr, to_addr, subject, status, attempts,
            next_attempt_at, sent_at, created_at, updated_at, batch_id
       FROM outbox
      WHERE ${where.join(' AND ')}
      ORDER BY id DESC LIMIT ${Number(limit)} OFFSET ${Number(offset)}`,
    args
  );
}

module.exports = {
  createQueued, createDroppedEvent, logEvent,
  selectDue, claimSending,
  markSent, markDeferred, markFailed, markBounced,
  findByIdOrUuid, listEvents, listForSender,
};
