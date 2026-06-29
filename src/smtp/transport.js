'use strict';

/**
 * Per-sender SMTP transport. Each registered sender has its own SMTP host /
 * port / TLS / credentials; we open a pooled transport per sender (keyed by
 * sender.id) so the connection cost is amortised across that sender's batch
 * but isolated from other tenants.
 *
 * Outbound message stamps:
 *  - envelope.from → bounce+<uuid>@<bounceDomain>  (VERP for DSN routing)
 *  - Message-ID    → <uuid@fromDomain>             (bounce correlation)
 *  - List-Unsubscribe (marketing only) → public /unsubscribe/<token>
 */

const nodemailer = require('nodemailer');
const config = require('../config');
const { decrypt } = require('../lib/crypto');
const { domainOf } = require('../lib/addresses');
const { needsUnsubscribe } = require('../lib/msgclass');

const transports = new Map(); // sender.id → transporter

function transportFor(sender) {
  if (transports.has(sender.id)) return transports.get(sender.id);
  const password = sender.smtp_password_enc
    ? decrypt(sender.smtp_password_enc, config.secrets.smtpEnc)
    : null;
  const t = nodemailer.createTransport({
    host: sender.smtp_host,
    port: sender.smtp_port,
    secure: !!sender.smtp_secure,
    auth: (sender.smtp_username || password) ? {
      user: sender.smtp_username || '',
      pass: password || '',
    } : undefined,
    pool: true,
    maxConnections: config.worker.maxInflightPerDomain,
    maxMessages: 100,
  });
  transports.set(sender.id, t);
  return t;
}

function closeFor(senderId) {
  const t = transports.get(senderId);
  if (t) { try { t.close(); } catch (_) {} transports.delete(senderId); }
}

/**
 * Send one prepared message. `prepared` carries the (post-template) subject /
 * html / text and any extra headers. Returns the provider Message-ID on
 * success; throws on SMTP error.
 */
async function sendPrepared(sender, prepared, { unsubscribeUrl = null } = {}) {
  const fromAddr = sender.address;
  const fromDomain = domainOf(fromAddr) || 'localhost';
  const envelopeFrom = config.bounce.domain
    ? `bounce+${prepared.uuid}@${config.bounce.domain}`
    : fromAddr;

  const headers = Object.assign({}, prepared.extraHeaders || {}, {
    'X-Mailer-Uuid': prepared.uuid,
    'X-Mailer-Sender': sender.uuid,
  });
  if (unsubscribeUrl && needsUnsubscribe(prepared.msgClass)) {
    headers['List-Unsubscribe'] = `<${unsubscribeUrl}>`;
    headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
  }

  const fromHeader = sender.display_name
    ? `"${sender.display_name.replace(/"/g, "'")}" <${fromAddr}>`
    : fromAddr;

  const info = await transportFor(sender).sendMail({
    from: fromHeader,
    to: prepared.to,
    replyTo: prepared.replyTo || sender.reply_to || undefined,
    subject: prepared.subject || '',
    html: prepared.html || undefined,
    text: prepared.text || undefined,
    messageId: `<${prepared.uuid}@${fromDomain}>`,
    headers,
    envelope: { from: envelopeFrom, to: prepared.to },
  });
  return info && info.messageId ? info.messageId : null;
}

async function verify(sender) {
  return transportFor(sender).verify();
}

function closeAll() {
  for (const [, t] of transports) { try { t.close(); } catch (_) {} }
  transports.clear();
}

module.exports = { sendPrepared, verify, closeFor, closeAll };
