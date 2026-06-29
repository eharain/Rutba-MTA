'use strict';

/**
 * Tiny forward-only migrator. Runs every *.sql in migrations/ in filename order,
 * tracked in a `_migrations` table so each file is applied once.
 *
 * Idempotency caveat: MySQL/InnoDB IMPLICITLY COMMITS before and after every DDL
 * statement (CREATE TABLE, ALTER TABLE, CREATE INDEX, …). The `withTransaction`
 * wrapper below therefore does NOT roll back partial migrations on failure —
 * authors of new migration files must make each individual DDL statement safely
 * re-runnable (e.g. `CREATE TABLE IF NOT EXISTS`, `DROP COLUMN IF EXISTS`,
 * check column existence before ALTER). DML inside a migration IS transactional.
 *
 * Usage: node src/migrate.js   (also called on boot from index.js)
 */

const fs = require('fs');
const path = require('path');
const db = require('./db');
const log = require('./logger');

const MIGRATIONS_DIR = path.join(__dirname, '..', 'migrations');

async function ensureTable() {
  await db.query(
    `CREATE TABLE IF NOT EXISTS _migrations (
       name VARCHAR(190) NOT NULL,
       applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
       PRIMARY KEY (name)
     ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`
  );
}

// Split a .sql file into individual statements. Our migrations use simple
// `;`-terminated statements with no stored routines, so a split on `;` at line
// ends is sufficient (comments stripped first).
function splitStatements(sql) {
  return sql
    .split(/\r?\n/)
    .filter((line) => !/^\s*--/.test(line))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
}

async function appliedSet() {
  const rows = await db.query('SELECT name FROM _migrations');
  return new Set(rows.map((r) => r.name));
}

async function run() {
  await ensureTable();
  const done = await appliedSet();
  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  let applied = 0;
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    const statements = splitStatements(sql);
    await db.withTransaction(async (conn) => {
      for (const stmt of statements) {
        await conn.query(stmt);
      }
      await conn.query('INSERT INTO _migrations (name) VALUES (?)', [file]);
    });
    applied += 1;
    log.info(`[migrate] applied ${file} (${statements.length} statements)`);
  }
  if (!applied) log.info('[migrate] up to date');
  return applied;
}

if (require.main === module) {
  run()
    .then(() => db.close())
    .then(() => process.exit(0))
    .catch((e) => {
      log.error('[migrate] failed:', e.message);
      process.exit(1);
    });
}

module.exports = { run };
