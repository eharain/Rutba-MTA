import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { parseBounce, extractUuid } = require('../src/lib/dsn.js');

const UUID = '3f1c8a2e-9b4d-4c1a-8e2f-7a6b5c4d3e2f';

const HARD_BOUNCE = `Return-Path: <bounce+${UUID}@bounce.trustlist.uk>
Content-Type: multipart/report; report-type=delivery-status; boundary="x"

--x
Content-Type: message/delivery-status

Original-Recipient: rfc822; deadmailbox@example.com
Final-Recipient: rfc822; deadmailbox@example.com
Action: failed
Status: 5.1.1
Diagnostic-Code: smtp; 550 5.1.1 <deadmailbox@example.com> user unknown
--x--`;

const SOFT_BOUNCE = `To: bounce+${UUID}@bounce.trustlist.uk
Content-Type: message/delivery-status

Final-Recipient: rfc822; busy@example.org
Action: delayed
Status: 4.2.2
Diagnostic-Code: smtp; 452 4.2.2 Mailbox full
`;

const ARF_COMPLAINT = `Content-Type: message/feedback-report

Feedback-Type: abuse
User-Agent: SomeFBL/1.0
Original-Mail-From: <bounce+${UUID}@bounce.trustlist.uk>
X-Mailer-Uuid: ${UUID}
`;

test('hard bounce → class hard, recipient + uuid recovered from VERP', () => {
  const r = parseBounce(HARD_BOUNCE);
  assert.equal(r.kind, 'bounce');
  assert.equal(r.bounceClass, 'hard');
  assert.equal(r.status, '5.1.1');
  assert.equal(r.recipient, 'deadmailbox@example.com');
  assert.equal(r.uuid, UUID);
});

test('soft bounce → class soft', () => {
  const r = parseBounce(SOFT_BOUNCE);
  assert.equal(r.kind, 'bounce');
  assert.equal(r.bounceClass, 'soft');
  assert.equal(r.status, '4.2.2');
  assert.equal(r.recipient, 'busy@example.org');
  assert.equal(r.uuid, UUID);
});

test('ARF feedback → complaint', () => {
  const r = parseBounce(ARF_COMPLAINT);
  assert.equal(r.kind, 'complaint');
  assert.equal(r.isComplaint, true);
  assert.equal(r.uuid, UUID);
});

test('non-bounce text → kind null', () => {
  const r = parseBounce('just a normal email, nothing to see');
  assert.equal(r.kind, null);
  assert.equal(r.isDsn, false);
});

test('extractUuid finds the X-Mailer-Uuid header form', () => {
  assert.equal(extractUuid(`X-Mailer-Uuid: ${UUID}`), UUID);
  assert.equal(extractUuid('nothing here'), null);
});
