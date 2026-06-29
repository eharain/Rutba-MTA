'use strict';

/**
 * Email action interception (CTAs, approvals, decline, confirm).
 *
 * On send, the caller registers an `actions` array; for every recipient we
 * generate one HMAC-signed token per action and persist a `message_action` row
 * mapping token → redirect URL. The template can reference the token URLs as
 * `{{action_key}}` placeholders, which the worker resolves at render time.
 *
 * On click (GET /action/:token), the API:
 *   1. verifies the HMAC (lib/tokens)
 *   2. loads the row, checks not-already-clicked + not-expired
 *   3. records the click event + webhook
 *   4. 302-redirects to the registered `redirect_url`
 */

const crypto = require('crypto');
const db = require('../db');
const { sign } = require('../lib/tokens');
const config = require('../config');

const ACTION_TYPES = new Set(['cta', 'approval', 'decline', 'confirm']);

function normalizeType(t) {
  const v = String(t || '').toLowerCase();
  return ACTION_TYPES.has(v) ? v : 'cta';
}

function expiryFromHours(h) {
  const hrs = Number(h);
  const eff = Number.isFinite(hrs) && hrs > 0 ? hrs : config.defaultActionExpiryHours;
  return new Date(Date.now() + eff * 3600_000);
}

/**
 * Create one set of action rows for a message. Returns a map of
 *   { actionKey: actionUrl }
 * which the caller can inject into template data before rendering.
 *
 * `messageId` is the outbox row id; `messageUuid` is its uuid.
 * `actions` is the caller-supplied array (validated minimally).
 */
async function createForMessage({ messageId, messageUuid, senderId, actions = [] }) {
  if (!Array.isArray(actions) || !actions.length) return {};
  if (!config.publicBaseUrl) {
    throw new Error('actions: MAILER_PUBLIC_URL must be set to generate action links');
  }
  const out = {};
  for (const a of actions) {
    if (!a || !a.key || !a.redirect) continue;
    const expiresAt = expiryFromHours(a.expires_hours);
    // Two-phase insert: we need the row's auto-increment id to sign the
    // final token, but `token` is UNIQUE and used as a primary lookup key.
    // Phase 1 inserts a unique random placeholder (NOT a constant — a
    // constant collides under concurrent inserts via UNIQUE constraint);
    // Phase 2 swaps it for the HMAC-signed token bound to the row's id.
    const placeholder = `pending:${crypto.randomBytes(16).toString('hex')}`;
    const res = await db.query(
      `INSERT INTO message_action
        (token, message_id, message_uuid, sender_id, action_key, action_type, label,
         redirect_url, expires_at)
       VALUES (?, ?,?,?,?,?,?, ?, ?)`,
      [
        placeholder,
        messageId, messageUuid, senderId,
        String(a.key).slice(0, 64),
        normalizeType(a.type),
        a.label ? String(a.label).slice(0, 190) : null,
        String(a.redirect).slice(0, 1024),
        expiresAt,
      ]
    );
    const token = sign(config.secrets.hmac, 'action', res.insertId, expiresAt.getTime());
    await db.query(`UPDATE message_action SET token = ? WHERE id = ?`, [token, res.insertId]);
    out[a.key] = `${config.publicBaseUrl}/action/${encodeURIComponent(token)}`;
  }
  return out;
}

async function findByToken(token) {
  const rows = await db.query(`SELECT * FROM message_action WHERE token = ? LIMIT 1`, [token]);
  return rows[0] || null;
}

async function markClicked(id, { ip = null, userAgent = null } = {}) {
  await db.query(
    `UPDATE message_action SET clicked_at = NOW(), click_ip = ?, click_ua = ?
      WHERE id = ? AND clicked_at IS NULL`,
    [ip, userAgent ? String(userAgent).slice(0, 512) : null, id]
  );
}

async function summaryForBatch(batchId) {
  const rows = await db.query(
    `SELECT a.action_key, COUNT(a.clicked_at) AS clicked
       FROM message_action a
       JOIN outbox o ON o.id = a.message_id
      WHERE o.batch_id = ?
      GROUP BY a.action_key`,
    [batchId]
  );
  const out = {};
  for (const r of rows) out[r.action_key] = Number(r.clicked) || 0;
  return out;
}

module.exports = { createForMessage, findByToken, markClicked, summaryForBatch, ACTION_TYPES };
