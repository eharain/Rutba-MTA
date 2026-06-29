'use strict';

/**
 * Webhook delivery worker. Drains `webhook_delivery` rows and POSTs them to
 * each sender's registered `webhook_url`. Retries on transient failure with
 * the same exponential backoff used for SMTP retries.
 */

const log = require('../logger');
const config = require('../config');
const webhooks = require('../services/webhooks');

class WebhookWorker {
  constructor() {
    this.running = false;
    this.timer = null;
  }

  start() {
    if (this.running) return;
    this.running = true;
    log.info('[webhook-worker] start');
    this.timer = setInterval(() => this.tick().catch((e) => log.error('[webhook-worker] tick', e.message)),
      config.webhook.tickMs);
  }

  stop() {
    this.running = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    log.info('[webhook-worker] stop');
  }

  async tick() {
    if (!this.running) return;
    const due = await webhooks.selectDue({ limit: 25 });
    for (const row of due) {
      webhooks.deliverOne(row).catch((e) => log.error('[webhook-worker] deliverOne', e.message));
    }
  }
}

module.exports = { WebhookWorker };
