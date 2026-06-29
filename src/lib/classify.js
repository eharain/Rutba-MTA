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

// Enhanced status codes that mean "this mailbox will never accept mail":
// 5.1.1 no such user, 5.1.10 / 5.4.x recipient address rejected, 5.2.1 disabled.
const SUPPRESS_STATUS_RE = /5\.(1\.[0-9]+|2\.1)/;

/**
 * Should a permanent failure also add the recipient to the suppression list?
 * Only for recipient-rejection codes — never for our-side envelope errors.
 */
function shouldSuppress(err) {
  if (classifyError(err) !== 'permanent') return false;
  const rc = smtpResponseCode(err);
  if (String((err && err.code) || '') === 'EENVELOPE') return false;
  const response = String((err && err.response) || '');
  if (SUPPRESS_STATUS_RE.test(response)) return true;
  // Bare 550/551/553 (mailbox unavailable / user not local) → suppress.
  return rc === 550 || rc === 551 || rc === 553;
}

module.exports = { classifyError, shouldSuppress, smtpResponseCode };
