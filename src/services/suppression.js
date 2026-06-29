'use strict';

const db = require('../db');
const { normalizeAddress } = require('../lib/addresses');

/**
 * Suppression list. A recipient is suppressed for app X if there is an ACTIVE row
 * whose scope is 'global' (address-level, e.g. hard bounce) OR equal to X
 * (per-tenant, e.g. an unsubscribe from that product's bulk mail).
 */

async function isSuppressed(app, address) {
  const addr = normalizeAddress(address);
  if (!addr) return false;
  const rows = await db.query(
    `SELECT id FROM email_suppression
       WHERE address = ? AND active = 1 AND scope IN ('global', ?)
       LIMIT 1`,
    [addr, app || 'global']
  );
  return rows.length > 0;
}

async function suppress({ address, scope = 'global', reason = 'manual_block', sourceUuid = null, note = null }) {
  const addr = normalizeAddress(address);
  if (!addr) return null;
  await db.query(
    `INSERT INTO email_suppression (address, scope, reason, active, source_uuid, note)
       VALUES (?, ?, ?, 1, ?, ?)
     ON DUPLICATE KEY UPDATE active = 1, reason = VALUES(reason),
       source_uuid = VALUES(source_uuid), note = VALUES(note)`,
    [addr, scope || 'global', reason, sourceUuid, note]
  );
  return { address: addr, scope: scope || 'global', reason };
}

async function unsuppress(address, scope = 'global') {
  const addr = normalizeAddress(address);
  if (!addr) return false;
  const res = await db.query(
    `UPDATE email_suppression SET active = 0 WHERE address = ? AND scope = ?`,
    [addr, scope || 'global']
  );
  return res.affectedRows > 0;
}

async function list({ app, includeGlobal = true, limit = 100, offset = 0 } = {}) {
  const scopes = includeGlobal ? ['global'] : [];
  if (app && app !== 'global') scopes.push(app);
  if (!scopes.length) return [];
  const placeholders = scopes.map(() => '?').join(',');
  return db.query(
    `SELECT address, scope, reason, active, source_uuid, note, created_at, updated_at
       FROM email_suppression
       WHERE scope IN (${placeholders})
       ORDER BY updated_at DESC
       LIMIT ? OFFSET ?`,
    [...scopes, Number(limit), Number(offset)]
  );
}

module.exports = { isSuppressed, suppress, unsuppress, list };
