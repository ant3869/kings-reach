// Asking the War Room whether it is busy, and refusing to stop it while it is. No real server, no real stop.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { warroomBusy, PROBE_TIMEOUT_MS } from '../dist/warroom-busy.js';
import { stopRefusal } from '../dist/warroom-supervisor.js';

const json = (body, ok = true) => async () => ({ ok, json: async () => body });

/** A websocket that answers a ping the way server v22 does. */
class FakeSocket {
  static last;
  constructor(reply) {
    this.reply = reply;
    this.sent = [];
    this.closed = false;
    FakeSocket.last = this;
    setTimeout(() => this.onopen?.(), 0);
  }
  send(text) {
    this.sent.push(JSON.parse(text));
    if (this.reply !== null) setTimeout(() => this.onmessage?.({ data: JSON.stringify(this.reply) }), 0);
  }
  close() {
    this.closed = true;
  }
}
const socketThatReplies = (reply) => class extends FakeSocket { constructor() { super(reply); } };

test('busy: a new server answers over plain HTTP and the websocket is never touched', async () => {
  let touched = false;
  const WS = class { constructor() { touched = true; } };
  assert.equal(await warroomBusy(1, json({ busy: 2, server: 23 }), WS), 2);
  assert.equal(touched, false, 'a websocket connection would take over a run waiting for its page');
});

test('busy: zero is a real answer, not a failure to answer', async () => {
  assert.equal(await warroomBusy(1, json({ busy: 0, server: 23 }), socketThatReplies(null)), 0);
});

test('busy: an older server (no /busy) is asked with the websocket ping instead', async () => {
  const WS = socketThatReplies({ pong: 'council-v8', busy: 1, server: 22 });
  assert.equal(await warroomBusy(1, json({}, false), WS), 1);
  assert.deepEqual(FakeSocket.last.sent, [{ type: 'ping' }]);
  assert.equal(FakeSocket.last.closed, true, 'the probe hangs up');
});

test('busy: an unreadable answer is "could not ask" (null), never a made-up zero', async () => {
  assert.equal(await warroomBusy(1, json({ busy: 'lots' }), socketThatReplies({ pong: 'x', busy: -3 })), null);
  assert.equal(await warroomBusy(1, json({ nope: 1 }), socketThatReplies({ pong: 'x' })), null);
});

test('busy: a server that is down, or silent, gives null within the timeout instead of hanging', async () => {
  const down = async () => { throw new Error('ECONNREFUSED'); };
  const WS = class { constructor() { throw new Error('refused'); } };
  assert.equal(await warroomBusy(1, down, WS), null);
  const patience = new Promise((_, reject) => setTimeout(() => reject(new Error('the probe never gave up on a silent server')), PROBE_TIMEOUT_MS + 700));
  assert.equal(await Promise.race([warroomBusy(1, down, socketThatReplies(null)), patience]), null, 'connects, never answers');
});

test('stop: refused while work is running, says how much, and carries the count for the dashboard', () => {
  const one = stopRefusal(1);
  assert.equal(one.ok, false);
  assert.equal(one.busy, 1);
  assert.match(one.error, /1 task is still running/);
  assert.match(one.error, /even with no page open/);
  assert.match(stopRefusal(3).error, /3 tasks are still running/);
});

test('stop: idle, or unable to ask, never blocks a stop (a wedged server must stay stoppable)', () => {
  assert.equal(stopRefusal(0), null);
  assert.equal(stopRefusal(null), null);
});
