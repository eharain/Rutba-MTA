'use strict';

/**
 * Suppression list. Scope = 'global' (cross-sender, set by hard bounce /
 * complaint / admin block) OR the sender's uuid (per-sender unsubscribe).
 *
 * `isSuppressed(senderUuid, address)` is the gate the API and worker call
 * before every send: returns the active suppression row, or null.
 */

const db = require('../db');
const { normalizeAddress } = require('../lib/addresses');

async function isSuppressed(senderUuid, address) {
  const addr = normalizeAddress(address);
  if (!addr) return null;
  const rows = await db.query(
    `SELECT id, address, scope, reason, source_uuid, note, created_at
       FROM suppression
      WHERE address = ?
        AND active = 1
        AND scope IN ('global', ?)
      LIMIT 1`,
    [addr, senderUuid || '']
  );
  return rows[0] || null;
}

async function suppress({ address, scope = 'global', reason = 'manual_block', sourceUuid = null, note = null }) {
  const addr = normalizeAddress(address);
  if (!addr) throw new Error('address required');
  // Upsert: re-suppression reactivates a previously cleared row and refreshes
  // the reason so the latest signal wins.
  await db.query(
    `INSERT INTO suppression (address, scope, reason, source_uuid, note, active)
       VALUES (?, ?, ?, ?, ?, 1)
     ON DUPLICATE KEY UPDATE
       reason = VALUES(reason),
       source_uuid = VALUES(source_uuid),
       note = VALUES(note),
       active = 1`,
    [addr, scope || 'global', reason, sourceUuid, note]
  );
}

async function unsuppress(address, scope = 'global') {
  const addr = normalizeAddress(address);
  await db.query(
    `UPDATE suppression SET active = 0 WHERE address = ? AND scope = ?`,
    [addr, scope]
  );
}

/**
 * List suppressions visible to a sender: their per-sender unsubscribes plus
 * the global list. Pagination via limit/offset.
 */
async function listForSender(senderUuid, { limit = 50, offset = 0, address = null } = {}) {
  const where = ['active = 1', "scope IN ('global', ?)"];
  const args = [senderUuid || ''];
  if (address) { where.push('address = ?'); args.push(normalizeAddress(address)); }
  const sql = `
    SELECT id, address, scope, reason, source_uuid, note, created_at, updated_at
      FROM suppression
     WHERE ${where.join(' AND ')}
     ORDER BY updated_at DESC
     LIMIT ${Number(limit) || 50} OFFSET ${Number(offset) || 0}`;
  return db.query(sql, args);
}

module.exports = { isSuppressed, suppress, unsuppress, listForSender };
