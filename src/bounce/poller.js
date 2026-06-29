'use strict';

const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const config = require('../config');
const log = require('../logger');
const messages = require('../services/messages');
const suppression = require('../services/suppression');
const reputation = require('../services/reputation');
const { parseBounce } = require('../lib/dsn');
const { domainOf } = require('../lib/addresses');

/**
 * Monitored-mailbox bounce recorder. Polls the bounce/return-path mailbox over
 * IMAP, parses DSN (RFC 3464) + ARF feedback reports, records an email_event,
 * flips the matched message to `bounced`, and suppresses the address on a hard
 * bounce / complaint. Modeled on RightApp's parser.js, but pull (IMAP) instead
 * of the Kafka pipeline.
 */
class BouncePoller {
  constructor() {
    this.timer = null;
    this.running = false;
    this.stopping = false;
  }

  start() {
    if (!config.bounce.enabled) {
      log.info('[bounce] disabled (set MAILER_BOUNCE_ENABLED=true to enable)');
      return;
    }
    if (!config.bounce.imap.user) {
      log.warn('[bounce] enabled but MAILER_BOUNCE_IMAP_USER is empty — skipping');
      return;
    }
    const loop = async () => {
      if (this.stopping) return;
      try { await this.pollOnce(); } catch (e) { log.error('[bounce] poll error:', e.message); }
      this.timer = setTimeout(loop, config.bounce.pollIntervalMs);
    };
    loop();
    log.info(`[bounce] poller started (every ${config.bounce.pollIntervalMs}ms)`);
  }

  async pollOnce() {
    if (this.running) return; // never overlap polls
    this.running = true;
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
        const unseen = await client.search({ seen: false });
        if (!unseen || !unseen.length) return;
        for (const seq of unseen) {
          try {
            const msg = await client.fetchOne(seq, { source: true });
            if (!msg || !msg.source) continue;
            await this.handleRaw(msg.source.toString('utf8'));
            await client.messageFlagsAdd(seq, ['\\Seen']);
          } catch (e) {
            log.warn(`[bounce] message ${seq} failed:`, e.message);
          }
        }
      } finally {
        lock.release();
      }
    } finally {
      try { await client.logout(); } catch (_) { /* ignore */ }
      this.running = false;
    }
  }

  /** Parse one raw bounce/complaint message and record it. */
  async handleRaw(raw) {
    // Prefer a structured parse for header access; fall back to the raw text.
    let text = raw;
    try {
      const parsed = await simpleParser(raw);
      text = [parsed.headerLines.map((h) => h.line).join('\n'), parsed.text || '', raw].join('\n');
    } catch (_) { /* use raw */ }

    const b = parseBounce(text);
    if (!b.kind) return; // not a bounce/complaint we recognise

    let message = b.uuid ? await messages.findByUuid(b.uuid) : null;
    const messageId = message ? message.id : null;
    const address = b.recipient || (message ? message.to_addr : null);

    await messages.addEvent({
      messageId,
      messageUuid: b.uuid || null,
      type: b.kind === 'complaint' ? 'complained' : 'bounced',
      smtpCode: b.status || null,
      bounceType: b.bounceClass || null,
      reason: b.diagnostic || null,
      raw: text.slice(0, 60000),
    });

    if (b.uuid) await messages.markBounced(b.uuid, b.diagnostic || b.status || b.kind);

    // Hard bounce or complaint → global suppression (protects shared reputation).
    const isHard = b.bounceClass === 'hard' || b.kind === 'complaint';
    if (isHard && address) {
      await suppression.suppress({
        address,
        scope: 'global',
        reason: b.kind === 'complaint' ? 'complaint' : 'hard_bounce',
        sourceUuid: b.uuid || null,
        note: (b.diagnostic || '').slice(0, 200),
      });
      const dom = domainOf(address);
      if (dom) await reputation.bump(dom, b.kind === 'complaint' ? { complained: 1 } : { bounced: 1 });
      log.info(`[bounce] ${b.kind} → suppressed ${address} (${b.status || ''})`);
    }
  }

  stop() {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
  }
}

module.exports = { BouncePoller };
