'use strict';

const log = require('./logger');
const config = require('./config');
const db = require('./db');
const migrate = require('./migrate');
const { buildApp } = require('./api/server');
const { SendWorker } = require('./worker/sender');
const { WebhookWorker } = require('./worker/webhook');
const { BouncePoller } = require('./bounce/poller');

async function main() {
  // Fail fast: required secrets must be set in production.
  if (config.env === 'production') {
    if (!config.secrets.hmac)    throw new Error('MAILER_HMAC_SECRET is required in production');
    if (!config.secrets.smtpEnc) throw new Error('MAILER_SMTP_ENC_KEY is required in production');
    if (!config.publicBaseUrl)   throw new Error('MAILER_PUBLIC_URL is required in production');
  } else {
    if (!config.secrets.hmac) {
      log.warn('MAILER_HMAC_SECRET not set — generating an ephemeral one (DEV ONLY).');
      config.secrets.hmac = require('crypto').randomBytes(32).toString('hex');
    }
    if (!config.secrets.smtpEnc) {
      log.warn('MAILER_SMTP_ENC_KEY not set — generating an ephemeral one (DEV ONLY).');
      config.secrets.smtpEnc = require('crypto').randomBytes(32).toString('hex');
    }
  }

  log.info(`[boot] Rutba MTA starting (env=${config.env}, db=${config.db.database})`);
  await db.ping();
  await migrate.run();

  const app = buildApp();
  const server = app.listen(config.port, () => log.info(`[boot] HTTP listening on :${config.port}`));

  const sendWorker = new SendWorker();
  const webhookWorker = new WebhookWorker();
  const bouncePoller = new BouncePoller();
  if (config.worker.enabled) {
    sendWorker.start();
    webhookWorker.start();
  }
  bouncePoller.start(); // self-skips when disabled

  let shuttingDown = false;
  async function shutdown(signal) {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`[boot] ${signal} — shutting down`);
    try { sendWorker.stop(); } catch (_) {}
    try { webhookWorker.stop(); } catch (_) {}
    try { bouncePoller.stop(); } catch (_) {}
    server.close();
    try { await db.close(); } catch (_) {}
    process.exit(0);
  }
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT',  () => shutdown('SIGINT'));
}

main().catch((e) => {
  log.error('[boot] failed:', e.stack || e.message);
  process.exit(1);
});
