'use strict';

/**
 * Classify an SMTP send error as transient (retry) or permanent (give up), and
 * decide whether a permanent failure warrants immediate suppression.
 * Pure — unit-tested in test/classify.test.mjs.
 */

// nodemailer surfaces network problems as err.code; SMTP rejections as
// err.responseCode (numeric) + err.response (text).
const TRANSIENT_CODES = new Set([
  'ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'ECONNRESET', 'EDNS',
  'EAI_AGAIN', 'ETLS', 'EHOSTUNREACH',
]);

function smtpResponseCode(err) {
  const rc = err && err.responseCode;
  return typeof rc === 'number' ? rc : null;
}

/** 'transient' | 'permanent'. Unknown → transient (safer to retry than to drop). */
function classifyError(err) {
  const rc = smtpResponseCode(err);
  if (rc != null) {
    if (rc >= 500 && rc < 600) return 'permanent';
    if (rc >= 400 && rc < 500) return 'transient';
  }
  const code = String((err && err.code) || '');
  if (TRANSIENT_CODES.has(code)) return 'transient';
  // EENVELOPE without a 5xx responseCode is usually a malformed/empty envelope
  // on our side — retrying won't help, but it's not a recipient problem, so we
  // do NOT suppress. Treat as permanent-but-no-suppress (see shouldSuppress).
  if (code === 'EENVELOPE') return 'permanent';
  return 'transient';
}

// RFC 3463 enhanced status code (class.subject.detail, e.g. 5.1.1). It has to
// stand alone, so the digits of an IP address or a version number are not read
// as one; a trailing full stop is allowed.
const ENHANCED_STATUS_RE = /(?<![\d.])([245])\.(\d{1,3})\.(\d{1,3})(?!\.?\d)/;

/** The first enhanced status code in an SMTP response, or null. */
function enhancedStatus(response) {
  const m = ENHANCED_STATUS_RE.exec(String(response || ''));
  return m ? { cls: Number(m[1]), subject: Number(m[2]), detail: Number(m[3]) } : null;
}

// Enhanced status codes that mean "this mailbox will never accept mail":
// 5.1.x bad destination address (5.1.1 no such user, 5.1.2 no such domain,
// 5.1.10 null MX) and 5.2.1 mailbox disabled. 5.1.7 and 5.1.8 are about our
// sender address (Postfix reports them at RCPT TO by default), not the
// recipient's.
function isRecipientStatus(s) {
  if (s.cls !== 5) return false;
  if (s.subject === 1) return s.detail !== 7 && s.detail !== 8;
  return s.subject === 2 && s.detail === 1;
}

/**
 * Should a permanent failure also add the recipient to the suppression list?
 * Only for recipient-rejection codes — never for our-side envelope errors.
 * Suppression is global and persistent, so when in doubt, don't.
 */
function shouldSuppress(err) {
  if (classifyError(err) !== 'permanent') return false;
  const rc = smtpResponseCode(err);
  // EENVELOPE is our-side (no responseCode: a malformed or empty envelope;
  // MAIL FROM: our sender address refused) unless the server refused the
  // recipient with a 5xx at RCPT TO, which is a hard bounce like any other.
  if (String((err && err.code) || '') === 'EENVELOPE') {
    const refusedAtRcpt = (err && err.command) === 'RCPT TO';
    if (!refusedAtRcpt || rc == null || rc < 500 || rc >= 600) return false;
  }
  // An enhanced status code says what the 5xx is about, so it decides even
  // under a bare 550: a policy, spam or relay refusal (5.7.x), a routing
  // problem (5.4.x) or a message problem (5.3.x, 5.5.x, 5.6.x) leaves the
  // mailbox valid. X.0.0 ("other") says nothing, so it counts as no code.
  const status = enhancedStatus(err && err.response);
  if (status && (status.subject !== 0 || status.detail !== 0)) return isRecipientStatus(status);
  // No enhanced status code: bare 550/551/553 (mailbox unavailable / user not
  // local / mailbox name not allowed) → suppress.
  return rc === 550 || rc === 551 || rc === 553;
}

module.exports = { classifyError, shouldSuppress, smtpResponseCode };
