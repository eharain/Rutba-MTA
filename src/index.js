'use strict';

const config = require('./config');
const log = require('./logger');
const db = require('./db');
const migrate = require('./migrate');
const { buildApp } = require('./api/server');
const { SendWorker } = require('./worker/sender');
const { BouncePoller } = require('./bounce/poller');
const transport = require('./smtp/transport');

async function main() {
  log.info(`[mailer] starting (env=${config.env}, db=${config.db.database}@${config.db.host})`);

  if (!config.apiKeys.size) {
    log.warn('[mailer] no MAILER_API_KEYS configured — every /v1 request will 401');
  }

  // DB must be reachable; migrate forward.
  await db.ping();
  await migrate.run();

  const app = buildApp();
  const server = app.listen(config.port, () => log.info(`[mailer] HTTP API on :${config.port}`));

  const worker = new SendWorker();
  const poller = new BouncePoller();
  if (config.worker.enabled) await worker.start();
  else log.info('[mailer] send worker disabled (MAILER_WORKER_ENABLED=false)');
  poller.start();

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`[mailer] ${signal} — shutting down`);
    await worker.stop();
    poller.stop();
    server.close();
    transport.close();
    try { await db.close(); } catch (_) { /* ignore */ }
    process.exit(0);
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}

main().catch((e) => {
  log.error('[mailer] fatal:', e.stack || e.message);
  process.exit(1);
});
