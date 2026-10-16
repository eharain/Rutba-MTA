import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { classifyError, shouldSuppress } = require('../src/lib/classify.js');

test('5xx SMTP responses are permanent', () => {
  assert.equal(classifyError({ responseCode: 550 }), 'permanent');
  assert.equal(classifyError({ responseCode: 553 }), 'permanent');
});

test('4xx SMTP responses are transient (greylisting, mailbox full)', () => {
  assert.equal(classifyError({ responseCode: 450 }), 'transient');
  assert.equal(classifyError({ responseCode: 421 }), 'transient');
  assert.equal(classifyError({ responseCode: 452 }), 'transient');
});

test('network errors are transient', () => {
  assert.equal(classifyError({ code: 'ETIMEDOUT' }), 'transient');
  assert.equal(classifyError({ code: 'ECONNECTION' }), 'transient');
  assert.equal(classifyError({ code: 'ESOCKET' }), 'transient');
});

test('unknown errors default to transient (safer to retry)', () => {
  assert.equal(classifyError({}), 'transient');
  assert.equal(classifyError({ code: 'WAT' }), 'transient');
});

test('EENVELOPE is permanent but never suppresses (our-side problem)', () => {
  assert.equal(classifyError({ code: 'EENVELOPE' }), 'permanent');
  assert.equal(shouldSuppress({ code: 'EENVELOPE' }), false);
});

test('EENVELOPE with a 5xx recipient rejection at RCPT TO suppresses', () => {
  // What nodemailer rejects sendMail with when the only recipient is refused.
  assert.equal(shouldSuppress({ code: 'EENVELOPE', command: 'RCPT TO', responseCode: 550, response: '550 5.1.1 user unknown' }), true);
  assert.equal(shouldSuppress({ code: 'EENVELOPE', command: 'RCPT TO', responseCode: 550, response: '550 5.2.1 mailbox disabled' }), true);
  assert.equal(shouldSuppress({ code: 'EENVELOPE', command: 'RCPT TO', responseCode: 551, response: '551 user not local' }), true);
  assert.equal(shouldSuppress({ code: 'EENVELOPE', command: 'RCPT TO', responseCode: 553, response: '553 mailbox name not allowed' }), true);
});

test('EENVELOPE that is not a recipient rejection never suppresses', () => {
  // No responseCode: a malformed or empty envelope on our side.
  assert.equal(shouldSuppress({ code: 'EENVELOPE', command: 'API' }), false);
  assert.equal(shouldSuppress({ code: 'EENVELOPE', command: 'RCPT TO' }), false);
  // Our sender address refused at MAIL FROM, even with a 5.1.x code.
  assert.equal(shouldSuppress({ code: 'EENVELOPE', command: 'MAIL FROM', responseCode: 553, response: '553 5.1.8 sender address rejected' }), false);
  // A 4xx at RCPT TO is transient.
  assert.equal(shouldSuppress({ code: 'EENVELOPE', command: 'RCPT TO', responseCode: 450, response: '450 4.2.1 try later' }), false);
  // A 5xx at RCPT TO that is not a recipient-rejection code.
  assert.equal(shouldSuppress({ code: 'EENVELOPE', command: 'RCPT TO', responseCode: 554, response: '554 5.7.1 relay access denied' }), false);
});

test('recipient-rejection codes suppress', () => {
  assert.equal(shouldSuppress({ responseCode: 550, response: '550 5.1.1 user unknown' }), true);
  assert.equal(shouldSuppress({ responseCode: 550, response: '550 mailbox unavailable' }), true);
  assert.equal(shouldSuppress({ responseCode: 553, response: '553 user not local' }), true);
});

test('a 5xx with a non-recipient enhanced status code never suppresses, even a bare 550', () => {
  // Policy, spam and relay refusals (5.7.x): the mailbox is fine.
  assert.equal(shouldSuppress({ code: 'EMESSAGE', command: 'DATA', responseCode: 550, response: '550 5.7.1 message rejected as spam' }), false);
  assert.equal(shouldSuppress({ responseCode: 550, response: '550 5.7.1 relay access denied' }), false);
  assert.equal(shouldSuppress({ code: 'EENVELOPE', command: 'RCPT TO', responseCode: 550, response: '550 5.7.1 <a@b.example>: Recipient address rejected: Access denied' }), false);
  assert.equal(shouldSuppress({ responseCode: 553, response: '553 5.7.1 sender not authorized' }), false);
  // Message problems (5.3.x, 5.5.x, 5.6.x), routing (5.4.x), mailbox full (5.2.2).
  assert.equal(shouldSuppress({ code: 'EMESSAGE', command: 'DATA', responseCode: 550, response: '550 5.3.4 message too big for system' }), false);
  assert.equal(shouldSuppress({ responseCode: 551, response: '551 5.5.2 syntax error' }), false);
  assert.equal(shouldSuppress({ code: 'EMESSAGE', command: 'DATA', responseCode: 550, response: '550 5.6.0 content rejected' }), false);
  assert.equal(shouldSuppress({ responseCode: 550, response: '550 5.4.4 unable to route' }), false);
  assert.equal(shouldSuppress({ responseCode: 552, response: '552 5.2.2 mailbox full' }), false);
  // Our sender address refused at RCPT TO (Postfix delays its rejects there).
  assert.equal(shouldSuppress({ code: 'EENVELOPE', command: 'RCPT TO', responseCode: 553, response: '553 5.1.8 <me@us.example>: Sender address rejected: Domain not found' }), false);
  assert.equal(shouldSuppress({ code: 'EENVELOPE', command: 'RCPT TO', responseCode: 550, response: '550 5.1.7 bad sender address syntax' }), false);
  // Multi-line reply (nodemailer joins the lines with \n): the code governs.
  assert.equal(shouldSuppress({ code: 'EMESSAGE', command: 'DATA', responseCode: 550, response: '550-5.7.1 Our system has detected\n550 5.7.1 that this message is likely spam' }), false);
  // The first code governs, not a recipient code mentioned later in the text.
  assert.equal(shouldSuppress({ responseCode: 550, response: '550 5.7.1 blocked, see https://help.example/5.1.1' }), false);
});

test('a recipient enhanced status code suppresses wherever it sits in the reply', () => {
  assert.equal(shouldSuppress({ responseCode: 550, response: '550-5.1.1 The email account does not exist\n550 5.1.1 Please try again' }), true);
  assert.equal(shouldSuppress({ responseCode: 550, response: '550 5.1.10 RESOLVER.ADR.RecipientNotFound; not found' }), true);
  assert.equal(shouldSuppress({ responseCode: 554, response: '554 delivery error: dd This user does not have an account (#5.1.1)' }), true);
  assert.equal(shouldSuppress({ responseCode: 554, response: '554 5.2.1 mailbox disabled.' }), true);
});

test('with no informative enhanced status code a bare 550/551/553 suppresses', () => {
  assert.equal(shouldSuppress({ responseCode: 550, response: '550 5.0.0 <a@b.example>... User unknown' }), true);
  assert.equal(shouldSuppress({ responseCode: 551, response: '551 user not local; please try <c@d.example>' }), true);
  // Dotted numbers that are not a status code: an IP address, a version.
  assert.equal(shouldSuppress({ responseCode: 550, response: '550 no such user here [10.5.1.2]' }), true);
  assert.equal(shouldSuppress({ responseCode: 553, response: '553 mailbox name not allowed (filter 2.5.1.4)' }), true);
  // Any other bare 5xx does not.
  assert.equal(shouldSuppress({ responseCode: 554, response: '554 transaction failed' }), false);
  assert.equal(shouldSuppress({ responseCode: 554, response: '554 5.0.0 transaction failed' }), false);
});

test('transient failures never suppress', () => {
  assert.equal(shouldSuppress({ responseCode: 450, response: '450 4.2.1 try later' }), false);
  assert.equal(shouldSuppress({ code: 'ETIMEDOUT' }), false);
});
