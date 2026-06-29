'use strict';

const nodemailer = require('nodemailer');
const config = require('../config');
const { domainOf } = require('../lib/addresses');

/**
 * Single pooled nodemailer transport to the Mailcow SMTP. Pooling = receiver/
 * receiving-server care: reuse connections, cap concurrency + messages/connection
 * instead of a fresh TCP+TLS handshake per message.
 */
let transporter = null;

function getTransport() {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: config.smtp.host,
      port: config.smtp.port,
      secure: config.smtp.secure,
      auth: config.smtp.user ? { user: config.smtp.user, pass: config.smtp.pass } : undefined,
      pool: config.smtp.pool,
      maxConnections: config.smtp.maxConnections,
      maxMessages: config.smtp.maxMessages,
    });
  }
  return transporter;
}

/**
 * Send one message. Sets:
 *  - envelope.from to a VERP return-path (bounce+<uuid>@bounceDomain) so DSNs
 *    route to the monitored mailbox and the poller can match by uuid.
 *  - Message-ID <uuid@fromDomain> + X-Mailer-Uuid/App headers (bounce matching).
 *  - List-Unsubscribe (one-click) for bulk mail (deliverability + compliance).
 * Returns the provider messageId.
 */
async function sendMessage(msg) {
  const fromAddr = msg.from || config.smtp.from;
  const fromDomain = domainOf(fromAddr) || 'trustlist.uk';

  const headers = Object.assign({}, msg.headers || {}, {
    'X-Mailer-Uuid': msg.uuid,
    'X-Mailer-App': msg.app || '',
  });
  if (msg.unsubscribeUrl) {
    headers['List-Unsubscribe'] = `<${msg.unsubscribeUrl}>`;
    headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
  }

  // TODO: for bulk mail, append a plain-text / HTML unsubscribe footer to the body
  //   containing the `unsubscribeUrl` so recipients who don't see mail-client
  //   header-based UI (webmail, mobile) still have a visible opt-out link.
  //   The URL is already set in `msg.unsubscribeUrl` (built by the worker from
  //   `/unsubscribe/:uuid`). Suppression scope stays per-app (existing behaviour).

  // VERP envelope sender so bounces are addressed back to a parseable mailbox.
  const envelopeFrom = config.bounce.domain
    ? `bounce+${msg.uuid}@${config.bounce.domain}`
    : fromAddr;

  const info = await getTransport().sendMail({
    from: fromAddr,
    to: msg.to,
    replyTo: msg.replyTo || config.smtp.replyTo || undefined,
    subject: msg.subject || '',
    html: msg.html || undefined,
    text: msg.text || undefined,
    messageId: `<${msg.uuid}@${fromDomain}>`,
    headers,
    envelope: { from: envelopeFrom, to: msg.to },
  });

  return info && info.messageId ? info.messageId : null;
}

async function verify() {
  return getTransport().verify();
}

function close() {
  if (transporter) { transporter.close(); transporter = null; }
}

module.exports = { sendMessage, verify, close };
