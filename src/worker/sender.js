'use strict';

const config = require('../config');
const log = require('../logger');
const messages = require('../services/messages');
const reputation = require('../services/reputation');
const suppression = require('../services/suppression');
const transport = require('../smtp/transport');
const { DomainLimiter } = require('../lib/rate-limiter');
const { delayForScore } = require('../lib/reputation');
const { bypassesPacing } = require('../lib/msgclass');
const { nextDelaySeconds } = require('../lib/backoff');
const { classifyError, shouldSuppress, smtpResponseCode } = require('../lib/classify');
const { domainOf } = require('../lib/addresses');

/**
 * The send worker drains the email_message queue, respecting:
 *  - per-domain drip (reputation score → delay) + per-domain & global concurrency
 *  - transactional bypass of pacing (still bounded by concurrency)
 *  - retry/backoff for transient failures; suppression for hard recipient rejects
 *
 * Single-process async loop; claimSending() is an atomic DB transition so even
 * overlapping ticks (or a second worker) never double-send.
 */
class SendWorker {
  constructor() {
    this.limiter = new DomainLimiter({
      globalMaxInflight: config.worker.globalMaxInflight,
      maxInflightPerDomain: config.worker.maxInflightPerDomain,
      defaultMinIntervalMs: config.worker.defaultMinIntervalMs,
    });
    this.scoreCache = new Map();
    this.inflight = new Set();
    this.timer = null;
    this.stopping = false;
  }

  async start() {
    try { this.scoreCache = await reputation.scoreMap(); } catch (e) { log.warn('[worker] score preload failed:', e.message); }
    const loop = async () => {
      if (this.stopping) return;
      try { await this.tick(); } catch (e) { log.error('[worker] tick error:', e.message); }
      this.timer = setTimeout(loop, config.worker.tickMs);
    };
    loop();
    // Refresh the reputation cache periodically (cheap; bounces change scores).
    this.repTimer = setInterval(async () => {
      try { this.scoreCache = await reputation.scoreMap(); } catch (_) { /* ignore */ }
    }, Math.max(30000, config.worker.tickMs * 30));
    log.info('[worker] started');
  }

  async tick() {
    const due = await messages.selectDue(config.worker.batchSize);
    if (!due.length) return;
    const now = Date.now();
    for (const m of due) {
      if (this.inflight.has(m.id)) continue;
      const domain = m.to_domain || domainOf(m.to_addr);
      const score = this.scoreCache.has(domain) ? this.scoreCache.get(domain) : 100;
      const minInterval = bypassesPacing(m.msg_class) ? 0 : delayForScore(score);
      if (!this.limiter.canSend(domain, now, minInterval)) continue;

      const won = await messages.claimSending(m.id);
      if (!won) continue;

      this.inflight.add(m.id);
      this.limiter.acquire(domain, Date.now());
      // Fire async; bounded by the limiter's concurrency caps via canSend above.
      this._send(m, domain).finally(() => {
        this.limiter.release(domain);
        this.inflight.delete(m.id);
      });
    }
  }

  async _send(m, domain) {
    let headers = null;
    try { headers = m.headers ? (typeof m.headers === 'string' ? JSON.parse(m.headers) : m.headers) : null; } catch (_) { headers = null; }

    const unsubscribeUrl = config.publicBaseUrl ? `${config.publicBaseUrl}/unsubscribe/${m.uuid}` : null;

    try {
      const providerId = await transport.sendMessage({
        uuid: m.uuid,
        app: m.app,
        from: m.from_addr,
        replyTo: m.reply_to,
        to: m.to_addr,
        subject: m.subject,
        html: m.html,
        text: m.body_text,
        headers,
        unsubscribeUrl,
      });
      await messages.markSent(m.id, providerId);
      await messages.addEvent({ messageId: m.id, messageUuid: m.uuid, type: 'sent', reason: providerId });
      const score = await reputation.bump(domain, { sent: 1, delivered: 1 });
      if (typeof score === 'number') this.scoreCache.set(domain, score);
    } catch (err) {
      await this._handleFailure(m, domain, err);
    }
  }

  async _handleFailure(m, domain, err) {
    const kind = classifyError(err);
    const code = smtpResponseCode(err);
    const reason = String((err && err.response) || (err && err.message) || err).slice(0, 1000);
    const attempts = (m.attempts || 0) + 1; // claimSending already incremented in DB
    const exhausted = attempts >= (m.max_attempts || 6);

    if (kind === 'transient' && !exhausted) {
      const delay = nextDelaySeconds(attempts);
      if (delay != null) {
        const next = new Date(Date.now() + delay * 1000);
        await messages.markDeferred(m.id, next, reason);
        await messages.addEvent({ messageId: m.id, messageUuid: m.uuid, type: 'deferred', smtpCode: code ? String(code) : null, reason });
        const ds = await reputation.bump(domain, { deferred: 1 });
        if (typeof ds === 'number') this.scoreCache.set(domain, ds);
        return;
      }
    }

    // Permanent, or transient but out of retries → fail.
    await messages.markFailed(m.id, reason);
    await messages.addEvent({ messageId: m.id, messageUuid: m.uuid, type: 'failed', smtpCode: code ? String(code) : null, reason });
    const bs = await reputation.bump(domain, { bounced: 1 });
    if (typeof bs === 'number') this.scoreCache.set(domain, bs);

    if (shouldSuppress(err)) {
      try {
        await suppression.suppress({ address: m.to_addr, scope: 'global', reason: 'hard_bounce', sourceUuid: m.uuid, note: reason.slice(0, 200) });
        log.info(`[worker] suppressed ${m.to_addr} (hard reject ${code || ''})`);
      } catch (e) { log.warn('[worker] suppress failed:', e.message); }
    }
  }

  async stop() {
    this.stopping = true;
    if (this.timer) clearTimeout(this.timer);
    if (this.repTimer) clearInterval(this.repTimer);
  }
}

module.exports = { SendWorker };
