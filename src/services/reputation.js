'use strict';

const db = require('../db');
const { reputationScore } = require('../lib/reputation');

/**
 * Persistence + recompute for per-domain reputation. The pure scoring math lives
 * in lib/reputation.js; this module just maintains the counters and cached score.
 */

const COLUMNS = ['sent', 'delivered', 'bounced', 'complained', 'deferred'];

/** Atomically bump one or more counters for a receiving domain, then recompute. */
async function bump(domain, deltas = {}) {
  if (!domain) return;
  const cols = Object.keys(deltas).filter((c) => COLUMNS.includes(c) && deltas[c]);
  if (!cols.length) return;

  // Ensure the row exists, then increment + recompute score in one round-trip set.
  await db.query(`INSERT IGNORE INTO domain_reputation (domain) VALUES (?)`, [domain]);
  const setSql = cols.map((c) => `${c} = ${c} + ?`).join(', ');
  const params = cols.map((c) => Number(deltas[c]) || 0);
  await db.query(`UPDATE domain_reputation SET ${setSql} WHERE domain = ?`, [...params, domain]);
  return recompute(domain);
}

async function recompute(domain) {
  const rows = await db.query(
    `SELECT sent, delivered, bounced, complained, deferred FROM domain_reputation WHERE domain = ?`,
    [domain]
  );
  if (!rows.length) return 100;
  const score = reputationScore(rows[0]);
  await db.query(`UPDATE domain_reputation SET score = ? WHERE domain = ?`, [score, domain]);
  return score;
}

/** Map of domain -> score, for the worker's in-memory pacing cache. */
async function scoreMap() {
  const rows = await db.query(`SELECT domain, score FROM domain_reputation`);
  const m = new Map();
  for (const r of rows) m.set(r.domain, r.score);
  return m;
}

module.exports = { bump, recompute, scoreMap };
