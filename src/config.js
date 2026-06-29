'use strict';

/**
 * Central config from env. The gateway is product-neutral: every product
 * (TrustList, Rutba ERP, future offers) authenticates with its own API key and
 * is identified by the `app`/tenant that key maps to.
 */

function bool(v, def = false) {
  if (v == null || v === '') return def;
  return /^(1|true|yes|on)$/i.test(String(v));
}
function int(v, def) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

// MAILER_API_KEYS = "trustlist:key_aaa,rutba:key_bbb"  (app:key pairs)
function parseApiKeys(raw) {
  const keyToApp = new Map();
  for (const pair of String(raw || '').split(',')) {
    const t = pair.trim();
    if (!t) continue;
    const i = t.indexOf(':');
    if (i < 1) continue;
    const app = t.slice(0, i).trim();
    const key = t.slice(i + 1).trim();
    if (app && key) keyToApp.set(key, app);
  }
  return keyToApp;
}

const config = {
  port: int(process.env.MAILER_PORT, 8025),
  env: process.env.NODE_ENV || 'development',

  db: {
    host: process.env.MAILER_DB_HOST || process.env.DB_HOST || 'mysql',
    port: int(process.env.MAILER_DB_PORT || process.env.DB_PORT, 3306),
    user: process.env.MAILER_DB_USER || process.env.DB_USER,
    password: process.env.MAILER_DB_PASSWORD || process.env.DB_PASSWORD,
    database: process.env.MAILER_DB_NAME || 'trustlist_mailer',
    connectionLimit: int(process.env.MAILER_DB_POOL, 10),
  },

  smtp: {
    host: process.env.SMTP_HOST || 'mail.trustlist.uk',
    port: int(process.env.SMTP_PORT, 587),
    secure: bool(process.env.SMTP_SECURE, false), // 587 = STARTTLS
    user: process.env.SMTP_USERNAME || '',
    pass: process.env.SMTP_PASSWORD || '',
    from: process.env.SMTP_FROM || 'no-reply@trustlist.uk',
    replyTo: process.env.SMTP_REPLY_TO || 'contact@trustlist.uk',
    // Connection pooling = receiver/receiving-server care (don't hammer a new
    // TCP+TLS handshake per message; cap concurrent connections + messages/conn).
    pool: bool(process.env.SMTP_POOL, true),
    maxConnections: int(process.env.SMTP_MAX_CONNECTIONS, 5),
    maxMessages: int(process.env.SMTP_MAX_MESSAGES, 100),
  },

  // VERP bounce return-path domain. Outbound envelope-from becomes
  // bounce+<uuid>@<bounceDomain> so DSNs route to the monitored mailbox and the
  // poller can match a bounce back to the exact message by uuid.
  bounce: {
    enabled: bool(process.env.MAILER_BOUNCE_ENABLED, false),
    domain: process.env.MAILER_BOUNCE_DOMAIN || 'bounce.trustlist.uk',
    mailbox: process.env.MAILER_BOUNCE_MAILBOX || 'INBOX',
    pollIntervalMs: int(process.env.MAILER_BOUNCE_POLL_MS, 60000),
    imap: {
      host: process.env.MAILER_BOUNCE_IMAP_HOST || process.env.SMTP_HOST || 'mail.trustlist.uk',
      port: int(process.env.MAILER_BOUNCE_IMAP_PORT, 993),
      secure: bool(process.env.MAILER_BOUNCE_IMAP_SECURE, true),
      user: process.env.MAILER_BOUNCE_IMAP_USER || '',
      pass: process.env.MAILER_BOUNCE_IMAP_PASS || '',
    },
  },

  worker: {
    enabled: bool(process.env.MAILER_WORKER_ENABLED, true),
    tickMs: int(process.env.MAILER_WORKER_TICK_MS, 1000),
    batchSize: int(process.env.MAILER_WORKER_BATCH, 50),
    globalMaxInflight: int(process.env.MAILER_GLOBAL_INFLIGHT, 20),
    maxInflightPerDomain: int(process.env.MAILER_DOMAIN_INFLIGHT, 5),
    // Floor delay between sends to the same domain (ms), independent of score.
    defaultMinIntervalMs: int(process.env.MAILER_DOMAIN_MIN_INTERVAL_MS, 0),
  },

  // app:key map + the apps allowed to do global suppression / cross-tenant reads.
  apiKeys: parseApiKeys(process.env.MAILER_API_KEYS),
  adminApps: new Set(
    String(process.env.MAILER_ADMIN_APPS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
  ),

  // Public base URL the unsubscribe + open-pixel links point at (this service).
  publicBaseUrl: (process.env.MAILER_PUBLIC_URL || '').replace(/\/$/, ''),
};

module.exports = config;
