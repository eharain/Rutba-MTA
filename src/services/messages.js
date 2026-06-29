'use strict';

const crypto = require('crypto');
const db = require('../db');
const { normalizeAddress, domainOf } = require('../lib/addresses');
const { normalizeClass } = require('../lib/msgclass');
const { maxAttempts } = require('../lib/backoff');

/**
 * email_message + email_event persistence. email_message doubles as the durable
 * send queue (status queued/deferred = work to do) and the audit log.
 */

async function addEvent({ messageId = null, messageUuid = null, type, smtpCode = null, bounceType = null, reason = null, raw = null }) {
  await db.query(
    `INSERT INTO email_event (message_id, message_uuid, type, smtp_code, bounce_type, reason, raw)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [messageId, messageUuid, type, smtpCode, bounceType, reason == null ? null : String(reason).slice(0, 2000), raw == null ? null : String(raw).slice(0, 60000)]
  );
}

/** Insert a message in `queued` state (the worker picks it up). */
async function createQueued(input) {
  const uuid = crypto.randomUUID();
  const to = normalizeAddress(input.to);
  const row = {
    uuid,
    app: input.app,
    msg_class: normalizeClass(input.msgClass),
    from_addr: input.from,
    reply_to: input.replyTo || null,
    to_addr: to,
    to_domain: domainOf(to),
    subject: input.subject || null,
    html: input.html || null,
    body_text: input.text || null,
    headers: input.headers ? JSON.stringify(input.headers) : null,
    template_slug: input.templateSlug || null,
    max_attempts: maxAttempts(),
    next_attempt_at: input.scheduledAt || null,
    scheduled_at: input.scheduledAt || null,
  };
  const res = await db.query(
    `INSERT INTO email_message
       (uuid, app, msg_class, from_addr, reply_to, to_addr, to_domain, subject, html, body_text, headers, template_slug, status, max_attempts, next_attempt_at, scheduled_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?)`,
    [row.uuid, row.app, row.msg_class, row.from_addr, row.reply_to, row.to_addr, row.to_domain, row.subject, row.html, row.body_text, row.headers, row.template_slug, row.max_attempts, row.next_attempt_at, row.scheduled_at]
  );
  const id = res.insertId;
  await addEvent({ messageId: id, messageUuid: uuid, type: 'queued' });
  return { id, uuid };
}

/** Log a send that was dropped before transport (suppressed recipient). */
async function createDropped(input, reason) {
  const uuid = crypto.randomUUID();
  const to = normalizeAddress(input.to);
  const res = await db.query(
    `INSERT INTO email_message
       (uuid, app, msg_class, from_addr, reply_to, to_addr, to_domain, subject, template_slug, status, error, sent_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'dropped', ?, NOW())`,
    [uuid, input.app, normalizeClass(input.msgClass), input.from, input.replyTo || null, to, domainOf(to), input.subject || null, input.templateSlug || null, reason || 'suppressed']
  );
  await addEvent({ messageId: res.insertId, messageUuid: uuid, type: 'dropped', reason });
  return { id: res.insertId, uuid };
}

/** Candidate messages whose time has come (queued or previously deferred). */
async function selectDue(limit, now = new Date()) {
  return db.query(
    `SELECT id, uuid, app, msg_class, from_addr, reply_to, to_addr, to_domain, subject, html, body_text, headers, attempts, max_attempts
       FROM email_message
       WHERE status IN ('queued','deferred')
         AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
       ORDER BY (msg_class = 'transactional') DESC, created_at ASC
       LIMIT ?`,
    [now, Number(limit)]
  );
}

/**
 * Atomically claim a message for sending: only succeeds if it is still
 * queued/deferred (guards against double-send across overlapping ticks/workers).
 * Returns true if this caller won the claim.
 */
async function claimSending(id) {
  const res = await db.query(
    `UPDATE email_message SET status = 'sending', attempts = attempts + 1
       WHERE id = ? AND status IN ('queued','deferred')`,
    [id]
  );
  return res.affectedRows === 1;
}

async function markSent(id, providerMessageId) {
  await db.query(
    `UPDATE email_message SET status = 'sent', sent_at = NOW(), provider_message_id = ?, error = NULL WHERE id = ?`,
    [providerMessageId || null, id]
  );
}

async function markDeferred(id, nextAttemptAt, error) {
  await db.query(
    `UPDATE email_message SET status = 'deferred', next_attempt_at = ?, error = ? WHERE id = ?`,
    [nextAttemptAt, String(error || '').slice(0, 2000), id]
  );
}

async function markFailed(id, error) {
  await db.query(
    `UPDATE email_message SET status = 'failed', error = ? WHERE id = ?`,
    [String(error || '').slice(0, 2000), id]
  );
}

async function markBounced(uuid, error) {
  const res = await db.query(
    `UPDATE email_message SET status = 'bounced', error = ? WHERE uuid = ?`,
    [String(error || '').slice(0, 2000), uuid]
  );
  return res.affectedRows > 0;
}

async function findByUuid(uuid) {
  const rows = await db.query(`SELECT * FROM email_message WHERE uuid = ? LIMIT 1`, [uuid]);
  return rows[0] || null;
}

async function listMessages({ app, status, to, limit = 50, offset = 0, admin = false }) {
  const where = [];
  const params = [];
  if (!admin) { where.push('app = ?'); params.push(app); }
  if (status) { where.push('status = ?'); params.push(status); }
  if (to) { where.push('to_addr = ?'); params.push(normalizeAddress(to)); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  return db.query(
    `SELECT id, uuid, app, msg_class, to_addr, subject, status, attempts, provider_message_id, error, sent_at, created_at
       FROM email_message ${clause}
       ORDER BY created_at DESC
       LIMIT ? OFFSET ?`,
    [...params, Number(limit), Number(offset)]
  );
}

async function getMessageWithEvents({ app, idOrUuid, admin = false }) {
  const byUuid = /^[0-9a-f-]{36}$/i.test(String(idOrUuid));
  const rows = await db.query(
    `SELECT * FROM email_message WHERE ${byUuid ? 'uuid' : 'id'} = ? LIMIT 1`,
    [idOrUuid]
  );
  const msg = rows[0];
  if (!msg) return null;
  if (!admin && msg.app !== app) return null;
  const events = await db.query(
    `SELECT type, smtp_code, bounce_type, reason, occurred_at FROM email_event WHERE message_id = ? ORDER BY id ASC`,
    [msg.id]
  );
  return { ...msg, events };
}

module.exports = {
  addEvent,
  createQueued,
  createDropped,
  selectDue,
  claimSending,
  markSent,
  markDeferred,
  markFailed,
  markBounced,
  findByUuid,
  listMessages,
  getMessageWithEvents,
};
