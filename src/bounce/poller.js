'use strict';

/**
 * IMAP bounce poller. Reads unseen mail from the configured bounce mailbox,
 * parses each as a DSN (RFC 3464) or ARF (RFC 5965) report, correlates back
 * to the originating outbox row by uuid (VERP envelope or X-Mailer-Uuid),
 * updates the message + domain reputation + suppression + webhook.
 *
 * Runs as a single instance (claim is not atomic across replicas).
 */

const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const config = require('../config');
const log = require('../logger');
const db = require('../db');
const { parseBounce } = require('../lib/dsn');
const messages = require('../services/messages');
const suppression = require('../services/suppression');
const domains = require('../services/domains');
const webhooks = require('../services/webhooks');

class BouncePoller {
  constructor() {
    this.running = false;
    this.timer = null;
  }

  start() {
    if (!config.bounce.enabled) {
      log.info('[bounce] disabled (MAILER_BOUNCE_ENABLED=false)');
      return;
    }
    if (!config.bounce.imap.host || !config.bounce.imap.user) {
      log.warn('[bounce] IMAP host/user not configured — skipping');
      return;
    }
    this.running = true;
    log.info('[bounce] start (poll every', config.bounce.pollIntervalMs, 'ms)');
    this.timer = setInterval(() => this.poll().catch((e) => log.error('[bounce] poll', e.message)),
      config.bounce.pollIntervalMs);
    // First poll immediately.
    this.poll().catch((e) => log.error('[bounce] poll', e.message));
  }

  stop() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    log.info('[bounce] stop');
  }

  async poll() {
    if (!this.running) return;
    const client = new ImapFlow({
      host: config.bounce.imap.host,
      port: config.bounce.imap.port,
      secure: config.bounce.imap.secure,
      auth: { user: config.bounce.imap.user, pass: config.bounce.imap.pass },
      logger: false,
    });
    try {
      await client.connect();
      const lock = await client.getMailboxLock(config.bounce.mailbox);
      try {
        for await (const msg of client.fetch({ seen: false }, { source: true, envelope: true })) {
          try {
            await this.handleRaw(msg.source);
            await client.messageFlagsAdd(msg.uid, ['\\Seen'], { uid: true });
          } catch (e) {
            log.warn('[bounce] handle', e.message);
          }
        }
      } finally {
        lock.release();
      }
    } finally {
      try { await client.logout(); } catch (_) {}
    }
  }

  async handleRaw(raw) {
    const text = Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw || '');
    const parsed = parseBounce(text);
    if (!parsed.kind || !parsed.uuid) {
      // Try a deeper parse for cases where the uuid is in an attached
      // original message rather than the top headers.
      try {
        const m = await simpleParser(text);
        const fallback = parseBounce((m.headers && m.headerLines && m.headerLines.map((h) => h.line).join('\n')) + '\n' + (m.text || ''));
        if (fallback.uuid) {
          parsed.uuid = parsed.uuid || fallback.uuid;
          parsed.kind = parsed.kind || fallback.kind;
          parsed.bounceClass = parsed.bounceClass || fallback.bounceClass;
        }
      } catch (_) {}
    }
    if (!parsed.kind || !parsed.uuid) {
      log.warn('[bounce] no uuid in incoming mail — ignoring');
      return;
    }

    const message = await messages.findByIdOrUuid(parsed.uuid);
    if (!message) {
      log.warn(`[bounce] no message for uuid ${parsed.uuid}`);
      return;
    }

    // Idempotency guard: handleRaw is sequenced after \Seen-marking, so a
    // crash between handler steps would re-deliver the same DSN. Don't
    // double-bump reputation, double-suppress, or re-fire webhooks.
    if (await this._alreadyProcessed(message, parsed)) {
      log.info(`[bounce] uuid=${message.uuid} already processed — skipping`);
      return;
    }

    if (parsed.kind === 'complaint') {
      await messages.markBounced(message.id, { reason: 'complaint' });
      await messages.logEvent({
        messageId: message.id, messageUuid: message.uuid, senderId: message.sender_id,
        type: 'complained', smtpCode: parsed.status, reason: parsed.diagnostic, raw: text,
      });
      await suppression.suppress({
        address: message.to_addr, scope: 'global', reason: 'complaint', sourceUuid: message.uuid,
      });
      await domains.bump(message.to_domain, { complained: 1 });
      await this.webhook(message, 'complained', { smtpCode: parsed.status, reason: parsed.diagnostic });
      return;
    }

    // bounce — hard vs soft
    const bc = parsed.bounceClass;
    if (bc === 'hard') {
      await messages.markBounced(message.id, { reason: parsed.diagnostic, smtpCode: parsed.status, bounceType: 'hard' });
      await messages.logEvent({
        messageId: message.id, messageUuid: message.uuid, senderId: message.sender_id,
        type: 'bounced', smtpCode: parsed.status, bounceType: 'hard', reason: parsed.diagnostic, raw: text,
      });
      await suppression.suppress({
        address: message.to_addr, scope: 'global', reason: 'hard_bounce', sourceUuid: message.uuid,
      });
      await domains.bump(message.to_domain, { bounced: 1 });
      await this.webhook(message, 'bounced', { bounceType: 'hard', smtpCode: parsed.status, reason: parsed.diagnostic });
    } else {
      // soft — just record; don't suppress, don't change status (the original send
      // succeeded; this is a downstream delayed bounce).
      await messages.logEvent({
        messageId: message.id, messageUuid: message.uuid, senderId: message.sender_id,
        type: 'bounced', smtpCode: parsed.status, bounceType: 'soft', reason: parsed.diagnostic, raw: text,
      });
      await domains.bump(message.to_domain, { deferred: 1 });
      await this.webhook(message, 'bounced', { bounceType: 'soft', smtpCode: parsed.status, reason: parsed.diagnostic });
    }
  }

  async _alreadyProcessed(message, parsed) {
    // Complaints have at most one ARF per message; bounces have at most one
    // hard/soft. If an event of the matching type already exists, treat as
    // already-handled.
    const type = parsed.kind === 'complaint' ? 'complained' : 'bounced';
    const rows = await db.query(
      `SELECT id FROM event WHERE message_id = ? AND type = ? LIMIT 1`,
      [message.id, type]
    );
    return rows.length > 0;
  }

  async webhook(message, event, extra) {
    try {
      await webhooks.enqueue({
        senderId: message.sender_id,
        messageId: message.id,
        batchId: message.batch_id,
        eventType: event,
        payload: {
          event, message_uuid: message.uuid, to: message.to_addr,
          class: message.msg_class, ...extra,
          occurred_at: new Date().toISOString(),
        },
      });
    } catch (e) { log.warn('[bounce] webhook enqueue', e.message); }
  }
}

module.exports = { BouncePoller };
