'use strict';

/**
 * DSN / bounce / complaint parsing. Pure (operates on the raw message text) —
 * unit-tested in test/dsn.test.mjs. Modeled on RightApp's parser.js.
 *
 * Extracts, from a returned (bounced) message or feedback report:
 *   - status     RFC 3463 enhanced code, e.g. "5.1.1" (hard) / "4.2.2" (soft)
 *   - action     "failed" | "delayed" | ...
 *   - recipient  the original failed recipient (Final-Recipient)
 *   - diagnostic the remote SMTP diagnostic line
 *   - uuid       OUR message uuid, recovered from the VERP return-path
 *                (bounce+<uuid>@…), an X-Mailer-Uuid header echoed back, or the
 *                original Message-ID <uuid@…>
 *   - kind       "bounce" | "complaint" | null
 *   - bounceClass"hard" | "soft" | null
 */

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

function firstMatch(text, re) {
  const m = text.match(re);
  return m ? m[1] : null;
}

function extractUuid(text) {
  return (
    firstMatch(text, new RegExp('bounce\\+(' + UUID + ')@', 'i')) ||
    firstMatch(text, new RegExp('X-Mailer-Uuid:\\s*(' + UUID + ')', 'i')) ||
    firstMatch(text, new RegExp('<(' + UUID + ')@', 'i')) ||
    null
  );
}

function parseBounce(raw) {
  const text = String(raw == null ? '' : raw);

  const isComplaint =
    /Feedback-Type:\s*abuse/i.test(text) ||
    /Content-Type:\s*message\/feedback-report/i.test(text) ||
    /report-type=disposition-notification/i.test(text);

  const status = firstMatch(text, /^\s*Status:\s*([245]\.\d+\.\d+)/im);
  const action = (firstMatch(text, /^\s*Action:\s*([a-z]+)/im) || '').toLowerCase() || null;
  const finalRecipient = firstMatch(text, /^\s*Final-Recipient:\s*[^;]+;\s*(.+)\s*$/im);
  const origRecipient = firstMatch(text, /^\s*Original-Recipient:\s*[^;]+;\s*(.+)\s*$/im);
  const diagnostic = firstMatch(text, /^\s*Diagnostic-Code:\s*(.+)\s*$/im);
  const uuid = extractUuid(text);

  let bounceClass = null;
  if (status) bounceClass = status[0] === '5' ? 'hard' : status[0] === '4' ? 'soft' : null;
  else if (action === 'failed') bounceClass = 'hard';
  else if (action === 'delayed') bounceClass = 'soft';

  const recipient = (finalRecipient || origRecipient || '').trim().toLowerCase() || null;
  const isDsn = !!(status || action || finalRecipient);

  let kind = null;
  if (isComplaint) kind = 'complaint';
  else if (isDsn) kind = 'bounce';

  return { kind, status, action, recipient, diagnostic, uuid, bounceClass, isDsn, isComplaint };
}

module.exports = { parseBounce, extractUuid };
