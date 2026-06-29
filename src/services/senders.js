'use strict';

/**
 * Sender registration + trust-token lookup.
 *
 * SMTP passwords are encrypted at rest with MAILER_SMTP_ENC_KEY (lib/crypto).
 * Trust tokens are NEVER stored in the clear — only their SHA-256 hash. The
 * raw token is returned exactly once at registration; loss requires rotation.
 */

const { randomUUID } = require('crypto');
const db = require('../db');
const { randomSecret, sha256Hex } = require('../lib/tokens');
const { encrypt } = require('../lib/crypto');
const { normalizeAddress } = require('../lib/addresses');
const config = require('../config');

const PUBLIC_FIELDS = `
  s.id, s.uuid, s.address, s.display_name, s.reply_to,
  s.smtp_host, s.smtp_port, s.smtp_secure, s.smtp_username,
  s.webhook_url, s.is_admin, s.status, s.created_at, s.updated_at
`;

function publicView(row) {
  if (!row) return null;
  return {
    uuid: row.uuid,
    address: row.address,
    displayName: row.display_name,
    replyTo: row.reply_to,
    smtp: {
      host: row.smtp_host,
      port: row.smtp_port,
      secure: !!row.smtp_secure,
      username: row.smtp_username,
    },
    webhookUrl: row.webhook_url,
    isAdmin: !!row.is_admin,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Register a new sender. Returns { sender, trustToken } — the trust token is
 * shown ONCE and never retrievable again.
 */
async function register({
  address,
  displayName = null,
  replyTo = null,
  smtp,
  webhookUrl = null,
  isAdmin = false,
}) {
  const addr = normalizeAddress(address);
  if (!addr) throw new Error('address required');
  if (!smtp || !smtp.host) throw new Error('smtp.host required');

  const uuid = randomUUID();
  const trustToken = randomSecret(32);
  const tokenHash = sha256Hex(trustToken);
  const webhookSecret = webhookUrl ? randomSecret(24) : null;
  const smtpPasswordEnc = smtp.password
    ? encrypt(smtp.password, config.secrets.smtpEnc)
    : null;

  await db.query(
    `INSERT INTO sender
      (uuid, address, display_name, reply_to,
       smtp_host, smtp_port, smtp_secure, smtp_username, smtp_password_enc,
       webhook_url, webhook_secret, is_admin, status, trust_token_hash)
     VALUES (?,?,?,?, ?,?,?,?,?, ?,?,?, 'active', ?)`,
    [
      uuid, addr, displayName, replyTo,
      smtp.host, smtp.port || 587, smtp.secure ? 1 : 0, smtp.username || null, smtpPasswordEnc,
      webhookUrl, webhookSecret, isAdmin ? 1 : 0, tokenHash,
    ]
  );
  const sender = await findByUuid(uuid);
  return { sender, trustToken, webhookSecret };
}

async function findByUuid(uuid) {
  const rows = await db.query(
    `SELECT ${PUBLIC_FIELDS} FROM sender s WHERE s.uuid = ? AND s.status <> 'deleted' LIMIT 1`,
    [uuid]
  );
  return publicView(rows[0]);
}

async function findByAddress(address) {
  const rows = await db.query(
    `SELECT ${PUBLIC_FIELDS} FROM sender s WHERE s.address = ? AND s.status <> 'deleted' LIMIT 1`,
    [normalizeAddress(address)]
  );
  return publicView(rows[0]);
}

/** Verify a presented trust token and return the (active) sender if valid. */
async function authenticate(trustToken) {
  if (!trustToken) return null;
  const hash = sha256Hex(trustToken);
  const rows = await db.query(
    `SELECT ${PUBLIC_FIELDS} FROM sender s
     WHERE s.trust_token_hash = ? AND s.status = 'active' LIMIT 1`,
    [hash]
  );
  return publicView(rows[0]);
}

/**
 * Internal sender row (with the encrypted SMTP password). For use by the
 * send worker only — never returned over the API.
 */
async function getInternalById(id) {
  const rows = await db.query(
    `SELECT id, uuid, address, display_name, reply_to,
            smtp_host, smtp_port, smtp_secure, smtp_username, smtp_password_enc,
            webhook_url, webhook_secret, is_admin, status
       FROM sender WHERE id = ? LIMIT 1`,
    [id]
  );
  return rows[0] || null;
}

async function update(uuid, patch) {
  const sender = await findByUuid(uuid);
  if (!sender) return null;

  const sets = [];
  const args = [];
  if (patch.displayName !== undefined) { sets.push('display_name = ?'); args.push(patch.displayName); }
  if (patch.replyTo !== undefined)    { sets.push('reply_to = ?'); args.push(patch.replyTo); }
  if (patch.webhookUrl !== undefined) { sets.push('webhook_url = ?'); args.push(patch.webhookUrl); }
  if (patch.smtp) {
    if (patch.smtp.host !== undefined)     { sets.push('smtp_host = ?'); args.push(patch.smtp.host); }
    if (patch.smtp.port !== undefined)     { sets.push('smtp_port = ?'); args.push(patch.smtp.port); }
    if (patch.smtp.secure !== undefined)   { sets.push('smtp_secure = ?'); args.push(patch.smtp.secure ? 1 : 0); }
    if (patch.smtp.username !== undefined) { sets.push('smtp_username = ?'); args.push(patch.smtp.username); }
    if (patch.smtp.password !== undefined) {
      sets.push('smtp_password_enc = ?');
      args.push(patch.smtp.password
        ? encrypt(patch.smtp.password, config.secrets.smtpEnc)
        : null);
    }
  }
  if (!sets.length) return sender;
  args.push(uuid);
  await db.query(`UPDATE sender SET ${sets.join(', ')} WHERE uuid = ?`, args);
  return findByUuid(uuid);
}

/** Soft-delete. In-flight messages drain naturally; future sends are rejected. */
async function softDelete(uuid) {
  await db.query(
    `UPDATE sender SET status = 'deleted' WHERE uuid = ?`,
    [uuid]
  );
}

/**
 * Rotate the trust token. Returns the new raw token (shown ONCE) and
 * invalidates the previous one.
 */
async function rotateToken(uuid) {
  const newToken = randomSecret(32);
  await db.query(
    `UPDATE sender SET trust_token_hash = ? WHERE uuid = ?`,
    [sha256Hex(newToken), uuid]
  );
  return newToken;
}

module.exports = {
  register, findByUuid, findByAddress, authenticate,
  getInternalById, update, softDelete, rotateToken, publicView,
};
