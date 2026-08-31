'use strict';

/**
 * Send worker. Drains the outbox queue:
 *   1. Pulls due rows; transactional are returned first (selectDue ORDER BY).
 *   2. For each row:
 *      - Resolve sender (load credentials).
 *      - If marketing: check per-domain reputation delay (skip if not ready).
 *      - Reserve a slot under the per-domain hard ceiling.
 *      - Atomically claim the row.
 *      - Render templates (subject/html/text) with stored data + action URLs.
 *      - SMTP-send via the sender's pooled transport.
 *      - Record sent/deferred/bounced/failed; update domain reputation; webhook.
 */

const db = require('../db');
const log = require('../logger');
const config = require('../config');
const messages = require('../services/messages');
const sendersSvc = require('../services/senders');
const suppression = require('../services/suppression');
const dnsGate = require('../services/dns-gate');
const domains = require('../services/domains');
const webhooks = require('../services/webhooks');
const transport = require('../smtp/transport');
const { needsUnsubscribe } = require('../lib/msgclass');
const { render } = require('../lib/template');
const { classifyError, shouldSuppress } = require('../lib/classify');
const { nextDelaySeconds } = require('../lib/backoff');
const { sign: signToken } = require('../lib/tokens');
const { DomainLimiter } = require('../lib/rate-limiter');

class SendWorker {
  constructor() {
    this.running = false;
    this.timer = null;
    this.pruneTick = 0;
    // In-process concurrency cap (global + per-domain). Adaptive pacing and
    // the per-minute hard ceiling are enforced by domains.tryReserveSlot
    // (atomic across replicas). DomainLimiter only stops one replica from
    // opening too many concurrent SMTP sessions at once.
    this.limiter = new DomainLimiter({
      globalMaxInflight: config.worker.globalMaxInflight,
      maxInflightPerDomain: config.worker.maxInflightPerDomain,
      defaultMinIntervalMs: 0,
    });
  }

  start() {
    if (this.running) return;
    this.running = true;
    log.info('[worker] start');
    this.timer = setInterval(() => this.tick().catch((e) => log.error('[worker] tick', e.message)),
      config.worker.tickMs);
  }

  stop() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    transport.closeAll();
    log.info('[worker] stop');
  }

  async tick() {
    if (!this.running) return;
    // Periodic housekeeping: prune old rate buckets every ~minute.
    this.pruneTick = (this.pruneTick + 1) % 60;
    if (this.pruneTick === 0) {
      domains.pruneBuckets().catch((e) => log.warn('[worker] prune', e.message));
    }
    const due = await messages.selectDue({ limit: config.worker.batchSize });
    for (const row of due) {
      // 1) In-process concurrency cap — prevents this replica from opening
      //    too many parallel SMTP sessions to one domain.
      if (!this.limiter.canSend(row.to_domain, Date.now())) continue;
      // 2) Cross-replica atomic pace + ceiling reservation.
      const reserved = await domains.tryReserveSlot(row.to_domain, row.msg_class);
      if (!reserved) continue;
      // 3) Claim the inflight slot and fan out (do NOT await — a slow SMTP
      //    shouldn't block the tick from processing other domains).
      this.limiter.acquire(row.to_domain, Date.now());
      this.processOne(row)
        .catch((e) => log.error('[worker] processOne', e.message))
        .finally(() => this.limiter.release(row.to_domain));
    }
  }

  async processOne(row) {
    const claimed = await messages.claimSending(row.id);
    if (!claimed) return;
    const sender = await sendersSvc.getInternalById(row.sender_id);
    if (!sender || sender.status !== 'active') {
      await messages.markFailed(row.id, 'sender_disabled');
      await messages.logEvent({ messageId: row.id, messageUuid: row.uuid, senderId: row.sender_id, type: 'failed', reason: 'sender_disabled' });
      return;
    }
    // Last-chance suppression (in case it was added since queue).
    const sup = await suppression.isSuppressed(sender.uuid, row.to_addr);
    if (sup) {
      await messages.markFailed(row.id, `suppressed:${sup.reason}`);
      await messages.logEvent({ messageId: row.id, messageUuid: row.uuid, senderId: row.sender_id, type: 'dropped', reason: `suppression:${sup.reason}` });
      return;
    }

    // The DNS gate's pre-send belt (the enqueue gate is primary). DEFER, not
    // fail: mail queued while the gate was off - or before the records
    // lapsed - flows the moment they appear, on the gate's own retry cadence.
    const dns = await dnsGate.ensureVerified(sender);
    if (!dns.ok) {
      const reason = `dns_gate: ${dns.domain} missing ${dns.missing.join(', ')}`;
      const nextAttemptAt = new Date(Date.now() + config.dnsGate.failRetrySeconds * 1000);
      await messages.markDeferred(row.id, { nextAttemptAt, reason });
      await messages.logEvent({ messageId: row.id, messageUuid: row.uuid, senderId: sender.id, type: 'deferred', reason });
      return;
    }

    const prepared = await this._render(row, sender);
    try {
      const providerId = await transport.sendPrepared(sender, prepared, {
        unsubscribeUrl: prepared.unsubscribeUrl,
      });
      await messages.markSent(row.id, providerId);
      await messages.logEvent({ messageId: row.id, messageUuid: row.uuid, senderId: sender.id, type: 'sent' });
      await domains.bump(row.to_domain, { sent: 1, delivered: 1 });
      await this._webhookEvent(sender.id, row, 'sent', { providerMessageId: providerId });
    } catch (err) {
      await this._handleSendError(row, sender, err);
    }
  }

  /**
   * Build the final {subject, html, text, headers, …} for SMTP from the stored
   * outbox row. Batch-rows store templates + per-recipient _data/_actions in
   * headers; single sends store fully-rendered subject/html/text already.
   */
  async _render(row, sender) {
    let headers = {};
    let data = null;
    let actionUrls = null;
    try { headers = row.headers ? JSON.parse(row.headers) : {}; } catch (_) {}
    if (headers._template) {
      data = headers._data || {};
      actionUrls = headers._actions || {};
      // Strip our internal keys before sending.
      delete headers._template;
      delete headers._data;
      delete headers._actions;
    }
    const templateCtx = Object.assign({}, data || {}, actionUrls || {});

    const subject = data ? render(row.subject, templateCtx) : (row.subject || '');
    const html = data ? render(row.html, templateCtx) : (row.html || null);
    const text = data ? render(row.body_text, templateCtx) : (row.body_text || null);

    // Marketing: build per-recipient unsubscribe URL (no expiry-relevant data).
    let unsubscribeUrl = null;
    if (needsUnsubscribe(row.msg_class) && config.publicBaseUrl) {
      const token = signToken(config.secrets.hmac, 'unsubscribe', row.id, 0);
      unsubscribeUrl = `${config.publicBaseUrl}/unsubscribe/${encodeURIComponent(token)}`;
    }

    return {
      uuid: row.uuid,
      to: row.to_addr,
      replyTo: row.reply_to,
      subject, html, text,
      msgClass: row.msg_class,
      extraHeaders: headers,
      unsubscribeUrl,
      // Carried through untouched: an iCalendar object is not a template and
      // must not be rendered. A {{token}} inside a UID or a DTSTART would be
      // substituted into nonsense, and the part has to arrive byte-identical
      // to what the calendar signed off.
      calendar: row.calendar_content
        ? { method: row.calendar_method || 'REQUEST', content: row.calendar_content }
        : null,
    };
  }

  async _handleSendError(row, sender, err) {
    const kind = classifyError(err);
    const smtpCode = (err && err.responseCode) ? String(err.responseCode) : null;
    const reason = err && err.message ? String(err.message).slice(0, 1000) : 'send failed';

    if (kind === 'permanent') {
      const isBounce = shouldSuppress(err);
      if (isBounce) {
        await messages.markBounced(row.id, { reason, smtpCode, bounceType: 'hard' });
        await messages.logEvent({ messageId: row.id, messageUuid: row.uuid, senderId: sender.id, type: 'bounced', smtpCode, bounceType: 'hard', reason });
        await suppression.suppress({ address: row.to_addr, scope: 'global', reason: 'hard_bounce', sourceUuid: row.uuid });
        await domains.bump(row.to_domain, { bounced: 1 });
        await this._webhookEvent(sender.id, row, 'bounced', { smtpCode, bounceType: 'hard', reason });
      } else {
        await messages.markFailed(row.id, reason);
        await messages.logEvent({ messageId: row.id, messageUuid: row.uuid, senderId: sender.id, type: 'failed', smtpCode, reason });
        await this._webhookEvent(sender.id, row, 'failed', { smtpCode, reason });
      }
      return;
    }

    // transient — defer with exponential backoff (attempts already incremented
    // in claimSending).
    const delaySec = nextDelaySeconds(row.attempts + 1);
    if (delaySec == null) {
      await messages.markFailed(row.id, reason);
      await messages.logEvent({ messageId: row.id, messageUuid: row.uuid, senderId: sender.id, type: 'failed', smtpCode, reason });
      await this._webhookEvent(sender.id, row, 'failed', { smtpCode, reason });
      return;
    }
    const nextAttemptAt = new Date(Date.now() + delaySec * 1000);
    await messages.markDeferred(row.id, { nextAttemptAt, reason });
    await messages.logEvent({ messageId: row.id, messageUuid: row.uuid, senderId: sender.id, type: 'deferred', smtpCode, reason });
    await domains.bump(row.to_domain, { deferred: 1 });
    await this._webhookEvent(sender.id, row, 'deferred', { smtpCode, reason, nextAttemptAt });
  }

  async _webhookEvent(senderId, row, type, extra = {}) {
    try {
      await webhooks.enqueue({
        senderId,
        messageId: row.id,
        batchId: row.batch_id,
        eventType: type,
        payload: {
          event: type,
          message_uuid: row.uuid,
          to: row.to_addr,
          class: row.msg_class,
          batch_uuid: row.batch_id ? undefined : undefined,
          ...extra,
          occurred_at: new Date().toISOString(),
        },
      });
    } catch (e) {
      log.warn('[worker] webhook enqueue', e.message);
    }
  }
}

module.exports = { SendWorker };
