'use strict';

/**
 * Central config from env. Rutba MTA is multi-tenant: every sender authenticates
 * with its own trust token (issued at registration) and brings its own SMTP
 * credentials — there are no global per-app keys or a global SMTP sender.
 */

function bool(v, def = false) {
  if (v == null || v === '') return def;
  return /^(1|true|yes|on)$/i.test(String(v));
}
function int(v, def) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}

const config = {
  port: int(process.env.MAILER_PORT, 8025),
  env: process.env.NODE_ENV || 'development',

  db: {
    host: process.env.MAILER_DB_HOST || process.env.DB_HOST || 'mysql',
    port: int(process.env.MAILER_DB_PORT || process.env.DB_PORT, 3306),
    user: process.env.MAILER_DB_USER || process.env.DB_USER,
    password: process.env.MAILER_DB_PASSWORD || process.env.DB_PASSWORD,
    database: process.env.MAILER_DB_NAME || 'mailers',
    connectionLimit: int(process.env.MAILER_DB_POOL, 10),
  },

  // Secrets. Both MUST be set in production. The HMAC secret signs action /
  // unsubscribe tokens; the encryption key wraps stored SMTP passwords.
  secrets: {
    hmac: process.env.MAILER_HMAC_SECRET || '',
    smtpEnc: process.env.MAILER_SMTP_ENC_KEY || '',
  },

  // VERP bounce return-path. Outbound envelope-from becomes
  // bounce+<uuid>@<bounceDomain> so the IMAP poller can match bounces back to
  // the originating message by uuid.
  bounce: {
    enabled: bool(process.env.MAILER_BOUNCE_ENABLED, false),
    domain: process.env.MAILER_BOUNCE_DOMAIN || 'bounce.rutba-mta.local',
    mailbox: process.env.MAILER_BOUNCE_MAILBOX || 'INBOX',
    pollIntervalMs: int(process.env.MAILER_BOUNCE_POLL_MS, 60000),
    imap: {
      host: process.env.MAILER_BOUNCE_IMAP_HOST || '',
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
    // Per-receiving-domain hard ceiling fallback (messages/minute) when no
    // domain-specific override is set. Applies to ALL classes, including
    // transactional.
    defaultMaxPerMinute: int(process.env.MAILER_DOMAIN_MAX_PER_MIN, 600),
    // Minimum sends to a domain before its reputation score is trusted.
    // During warmup we treat the domain as score 80.
    warmupMinSamples: int(process.env.MAILER_WARMUP_MIN, 20),
  },

  webhook: {
    timeoutMs: int(process.env.MAILER_WEBHOOK_TIMEOUT_MS, 10000),
    maxAttempts: int(process.env.MAILER_WEBHOOK_MAX_ATTEMPTS, 6),
    tickMs: int(process.env.MAILER_WEBHOOK_TICK_MS, 5000),
  },

  // Public base URL the action/unsubscribe links point at (this service).
  // MUST be set in production or links will be broken.
  publicBaseUrl: (process.env.MAILER_PUBLIC_URL || '').replace(/\/$/, ''),

  // Default per-action expiry when the caller doesn't set one (hours).
  defaultActionExpiryHours: int(process.env.MAILER_ACTION_EXPIRY_HOURS, 72),
};

module.exports = config;
