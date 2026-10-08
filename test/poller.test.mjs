import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { BouncePoller } = require('../src/bounce/poller.js');

// The bounce poller against a stand-in for imapflow. The real client runs one
// command at a time, so a command issued while a fetch is still streaming
// waits for it forever; this fake refuses one outright, which is how the
// 2026-10-08 hang (and the crash that followed it) shows up here.
class FakeImap extends EventEmitter {
  constructor(messages) {
    super();
    this.messages = messages;
    this.fetching = false;
    this.seen = [];
    this.loggedOut = false;
  }
  async connect() {}
  async getMailboxLock() { return { release() {} }; }
  async *fetch() {
    this.fetching = true;
    try {
      for (const m of this.messages) yield m;
    } finally {
      this.fetching = false;
    }
  }
  async messageFlagsAdd(uids, flags) {
    if (this.fetching) throw new Error('command issued during a fetch: imapflow would wait forever');
    this.seen.push(...[].concat(uids));
    assert.deepEqual(flags, ['\\Seen']);
  }
  async logout() { this.loggedOut = true; }
  close() {}
}

const NOT_A_BOUNCE = Buffer.from('From: TrustList <hello@trustlist.uk>\r\nSubject: MTA DKIM check\r\n\r\nNot a delivery report.\r\n');

function pollerWith(client) {
  const poller = new BouncePoller({ createClient: () => client });
  poller.running = true;
  return poller;
}

test('mail that is not a bounce of ours is read once and marked seen after the fetch, never inside it', async () => {
  const client = new FakeImap([{ uid: 7, source: NOT_A_BOUNCE }]);
  await pollerWith(client).poll();
  assert.deepEqual(client.seen, [7]);
  assert.equal(client.loggedOut, true);
});

test('every message of a poll is marked in one command once the fetch has ended', async () => {
  const client = new FakeImap([{ uid: 1, source: NOT_A_BOUNCE }, { uid: 2, source: NOT_A_BOUNCE }, { uid: 3, source: NOT_A_BOUNCE }]);
  await pollerWith(client).poll();
  assert.deepEqual(client.seen, [1, 2, 3]);
});

test('a message that fails to process stays unseen for the next poll; the others are marked', async () => {
  const client = new FakeImap([{ uid: 1, source: NOT_A_BOUNCE }, { uid: 2, source: Buffer.from('boom') }]);
  const poller = pollerWith(client);
  const real = poller.handleRaw.bind(poller);
  poller.handleRaw = async (raw) => {
    if (String(raw) === 'boom') throw new Error('database away');
    return real(raw);
  };
  await poller.poll();
  assert.deepEqual(client.seen, [1]);
});

test('a socket error on the IMAP client is handled, not left to end the process', async () => {
  const client = new FakeImap([]);
  await pollerWith(client).poll();
  assert.ok(client.listenerCount('error') > 0, 'an error listener is attached');
  assert.doesNotThrow(() => client.emit('error', Object.assign(new Error('Socket timeout'), { code: 'ETIMEOUT' })));
});

test('ticks do not overlap: while one poll is open the next tick opens no second connection', async () => {
  let opened = 0;
  let release;
  const gate = new Promise((r) => { release = r; });
  const client = new FakeImap([]);
  client.connect = async () => { opened += 1; await gate; };
  const poller = new BouncePoller({ createClient: () => client });
  poller.running = true;
  const first = poller.tick();
  await poller.tick();
  assert.equal(opened, 1);
  release();
  await first;
  assert.equal(poller.polling, false);
});

test('a poll that throws is caught by tick and the next tick runs', async () => {
  const client = new FakeImap([]);
  client.connect = async () => { throw new Error('ECONNREFUSED'); };
  const poller = pollerWith(client);
  await poller.tick();
  assert.equal(poller.polling, false);
});
