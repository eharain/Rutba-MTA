'use strict';

/**
 * Per-receiving-domain reputation + rate-ceiling state. The worker calls
 * `getOrCreate` to look up score + ceiling for a domain before sending, and
 * `bump` after every outcome (sent / bounced / complained / deferred) — which
 * recomputes the score in the same transaction.
 *
 * Also implements the hard ceiling (messages/minute, per domain) via the
 * `domain_rate_bucket` table.
 */

const db = require('../db');
const { reputationScore, effectiveScore, delayForScore } = require('../lib/reputation');
const config = require('../config');

async function getOrCreate(domain) {
  if (!domain) return null;
  const lc = String(domain).toLowerCase();
  let rows = await db.query(`SELECT * FROM domain_reputation WHERE domain = ? LIMIT 1`, [lc]);
  if (rows[0]) return rows[0];
  await db.query(
    `INSERT IGNORE INTO domain_reputation (domain, score) VALUES (?, 100)`,
    [lc]
  );
  rows = await db.query(`SELECT * FROM domain_reputation WHERE domain = ? LIMIT 1`, [lc]);
  return rows[0] || null;
}

/**
 * Increment counters for a domain and recompute its score. `deltas` keys:
 * sent, delivered, bounced, complained, deferred. Returns the updated row.
 */
async function bump(domain, deltas = {}) {
  const lc = String(domain || '').toLowerCase();
  if (!lc) return null;
  await getOrCreate(lc);
  const fields = ['sent', 'delivered', 'bounced', 'complained', 'deferred'];
  const sets = fields
    .filter((f) => Number(deltas[f]) > 0)
    .map((f) => `${f} = ${f} + ${Number(deltas[f])}`);
  if (deltas.sent > 0) sets.push('last_sent_at = CURRENT_TIMESTAMP');
  if (sets.length) {
    await db.query(`UPDATE domain_reputation SET ${sets.join(', ')} WHERE domain = ?`, [lc]);
  }
  // Recompute score from fresh counters.
  const rows = await db.query(`SELECT * FROM domain_reputation WHERE domain = ? LIMIT 1`, [lc]);
  const row = rows[0];
  if (!row) return null;
  const newScore = reputationScore(row, config.worker.warmupMinSamples);
  if (newScore !== row.score) {
    await db.query(`UPDATE domain_reputation SET score = ? WHERE domain = ?`, [newScore, lc]);
    row.score = newScore;
  }
  return row;
}

/** Effective score (respects admin override). */
async function scoreFor(domain) {
  const row = await getOrCreate(domain);
  return effectiveScore(row, config.worker.warmupMinSamples);
}

/** Per-domain delay (ms) for a marketing send. Transactional callers bypass. */
async function delayMsFor(domain) {
  return delayForScore(await scoreFor(domain));
}

/**
 * Cross-replica send-slot reservation. Atomically:
 *  - locks the domain's reputation row
 *  - for MARKETING: enforces the reputation-derived inter-send delay vs
 *    `last_sent_at` (cross-replica pacing — the previous in-process gate
 *    only saw THIS replica's sends)
 *  - for ALL classes: enforces the per-domain hard ceiling
 *    (messages/minute) and increments the bucket
 *  - stamps `last_sent_at` so concurrent ticks across replicas observe the
 *    reservation immediately
 *
 * Returns true if the caller may send, false if the caller must wait.
 */
async function tryReserveSlot(domain, msgClass, now = new Date()) {
  const lc = String(domain || '').toLowerCase();
  if (!lc) return true;
  await getOrCreate(lc); // ensure the row exists before FOR UPDATE
  const isMarketing = msgClass !== 'transactional';

  return db.withTransaction(async (conn) => {
    const [rows] = await conn.query(
      `SELECT * FROM domain_reputation WHERE domain = ? FOR UPDATE`,
      [lc]
    );
    const row = rows[0];
    if (!row) return true; // ghost — let it through; getOrCreate will catch it next tick

    // Marketing pacing: cross-replica inter-send delay.
    if (isMarketing) {
      const score = effectiveScore(row, config.worker.warmupMinSamples);
      const delayMs = delayForScore(score);
      if (row.last_sent_at && delayMs > 0) {
        const lastMs = new Date(row.last_sent_at).getTime();
        if (now.getTime() - lastMs < delayMs) return false;
      }
    }

    // Hard ceiling (all classes).
    const ceiling = row.max_per_minute
      ? Number(row.max_per_minute)
      : config.worker.defaultMaxPerMinute;
    if (ceiling && ceiling > 0) {
      const minuteStart = new Date(now);
      minuteStart.setSeconds(0, 0);
      const [bucketRows] = await conn.query(
        `SELECT count FROM domain_rate_bucket WHERE domain = ? AND minute_start = ?`,
        [lc, minuteStart]
      );
      const used = bucketRows[0] ? Number(bucketRows[0].count) : 0;
      if (used >= ceiling) return false;
      await conn.query(
        `INSERT INTO domain_rate_bucket (domain, minute_start, count)
           VALUES (?, ?, 1)
         ON DUPLICATE KEY UPDATE count = count + 1`,
        [lc, minuteStart]
      );
    }

    // Stamp last_sent_at so the next replica/tick sees the reservation.
    await conn.query(
      `UPDATE domain_reputation SET last_sent_at = ? WHERE domain = ?`,
      [now, lc]
    );
    return true;
  });
}

/** Prune rate buckets older than 5 minutes. Called periodically by the worker. */
async function pruneBuckets() {
  const cutoff = new Date(Date.now() - 5 * 60_000);
  await db.query(`DELETE FROM domain_rate_bucket WHERE minute_start < ?`, [cutoff]);
}

async function listAll({ limit = 200, offset = 0 } = {}) {
  return db.query(
    `SELECT * FROM domain_reputation ORDER BY sent DESC, domain ASC LIMIT ${Number(limit)} OFFSET ${Number(offset)}`
  );
}

async function setOverrides(domain, { scoreOverride = undefined, maxPerMinute = undefined, notes = undefined } = {}) {
  const lc = String(domain || '').toLowerCase();
  await getOrCreate(lc);
  const sets = [];
  const args = [];
  if (scoreOverride !== undefined) {
    sets.push('score_override = ?');
    args.push(scoreOverride === null ? null : Math.max(0, Math.min(100, Number(scoreOverride))));
  }
  if (maxPerMinute !== undefined) {
    sets.push('max_per_minute = ?');
    args.push(maxPerMinute === null ? null : Math.max(0, Number(maxPerMinute)));
  }
  if (notes !== undefined) { sets.push('notes = ?'); args.push(notes); }
  if (!sets.length) return getOrCreate(lc);
  args.push(lc);
  await db.query(`UPDATE domain_reputation SET ${sets.join(', ')} WHERE domain = ?`, args);
  return (await db.query(`SELECT * FROM domain_reputation WHERE domain = ? LIMIT 1`, [lc]))[0];
}

async function resetCounters(domain) {
  const lc = String(domain || '').toLowerCase();
  await db.query(
    `UPDATE domain_reputation
        SET sent = 0, delivered = 0, bounced = 0, complained = 0, deferred = 0, score = 100
      WHERE domain = ?`,
    [lc]
  );
}

module.exports = {
  getOrCreate, bump, scoreFor, delayMsFor,
  tryReserveSlot, pruneBuckets,
  listAll, setOverrides, resetCounters,
};
