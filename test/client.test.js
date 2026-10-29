// -----------------------------------------------------------------------------
// The TCP client: one connection, one request in flight, lines ended by CR LF
// (split anywhere), the answer found by its messageID among other lines, a
// line too long cut before it ends, a timeout or an abort closing the
// connection (a new one only after the close), beforeSend refusing before
// the first byte.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { LIMITS } from '../src/constants.js';
import { ERROR_KINDS, PanelClient } from '../src/ic/client.js';
import { settle, testClock } from './kit/clock.mjs';

const ADDRESS = { host: '192.168.1.60', port: 6681 };

/** A socket the test drives: `written` holds what the client wrote. */
function scriptedSocket(clock, { refuse = false } = {}) {
  const sockets = [];
  const connect = () => {
    const s = new EventEmitter();
    s.written = [];
    s.destroyed = false;
    s.closed = false;
    s.write = (text) => {
      s.written.push(text);
      return true;
    };
    s.destroy = () => {
      if (s.destroyed) return;
      s.destroyed = true;
      clock.timers.setTimeout(() => {
        s.closed = true;
        s.emit('close');
      }, 5);
    };
    clock.timers.setTimeout(() => {
      if (refuse) {
        s.destroyed = true;
        s.emit('error', new Error('ECONNREFUSED'));
        s.emit('close');
      } else s.emit('connect');
    }, 1);
    sockets.push(s);
    return s;
  };
  return { connect, sockets };
}

async function run(clock, promise, ms = 10_000) {
  let settled = false;
  promise.then(
    () => (settled = true),
    () => (settled = true),
  );
  for (let e = 0; e < ms && !settled; e += 5) {
    await clock.advance(5);
    await settle(2);
  }
  return promise;
}

const idOf = (text) => JSON.parse(text).messageID;

test('the answer is the line with our messageID, split anywhere; other lines skipped', async () => {
  const clock = testClock();
  const net = scriptedSocket(clock);
  const client = new PanelClient({
    connect: net.connect,
    timers: clock.timers,
    now: clock.monotonic,
  });
  const p = client.request(ADDRESS, 'GetParamList', { objectList: [] }, { timeoutMs: 5000 });
  await run(clock, Promise.race([new Promise((r) => clock.timers.setTimeout(r, 20)), p]));
  const s = net.sockets[0];
  const id = idOf(s.written[0].trimEnd());
  assert.ok(s.written[0].endsWith('\r\n'));
  const answer = `{"messageID":"${id}","response":"200","objectList":[]}\r\n`;
  s.emit(
    'data',
    Buffer.from(
      '{"command":"NotifyList","objectList":[]}\r\n{"messageID":"other","response":"400"}\r\nnot json\r\n',
    ),
  );
  s.emit('data', Buffer.from(answer.slice(0, 10)));
  s.emit('data', Buffer.from(answer.slice(10, -1)));
  s.emit('data', Buffer.from(answer.slice(-1)));
  const message = await run(clock, p);
  assert.equal(message.response, '200');
  assert.equal(net.sockets.length, 1);
});

test('a code other than 200 is a refusal; the connection stays', async () => {
  const clock = testClock();
  const net = scriptedSocket(clock);
  const client = new PanelClient({
    connect: net.connect,
    timers: clock.timers,
    now: clock.monotonic,
  });
  const p = client.request(ADDRESS, 'SETPARAMLIST', {}, { timeoutMs: 5000 });
  p.catch(() => {});
  await run(clock, Promise.race([new Promise((r) => clock.timers.setTimeout(r, 20)), p]));
  const s = net.sockets[0];
  s.emit('data', Buffer.from(`{"messageID":"${idOf(s.written[0])}","response":"400"}\r\n`));
  await assert.rejects(
    run(clock, p),
    (err) => err.kind === ERROR_KINDS.REFUSED && err.code === '400' && err.sent,
  );
  assert.equal(s.destroyed, false);
});

test('a line too long is cut before it ends; the connection closes', async () => {
  const clock = testClock();
  const net = scriptedSocket(clock);
  const client = new PanelClient({
    connect: net.connect,
    timers: clock.timers,
    now: clock.monotonic,
  });
  const p = client.request(ADDRESS, 'GetParamList', {}, { timeoutMs: 60_000 });
  p.catch(() => {});
  await run(clock, Promise.race([new Promise((r) => clock.timers.setTimeout(r, 20)), p]));
  const s = net.sockets[0];
  const chunk = Buffer.alloc(256 * 1024, 0x61);
  for (let i = 0; i < 4; i += 1) s.emit('data', chunk);
  assert.equal(s.destroyed, false, 'exactly 1 MiB is still allowed');
  s.emit('data', Buffer.from('a'));
  assert.equal(s.destroyed, true, 'cut before the line ends');
  await assert.rejects(run(clock, p), (err) => err.kind === ERROR_KINDS.PROTOCOL);
  assert.equal(LIMITS.maxLineBytes, 1024 * 1024);
});

test('too many lines that are not the answer: given up', async () => {
  const clock = testClock();
  const net = scriptedSocket(clock);
  const client = new PanelClient({
    connect: net.connect,
    timers: clock.timers,
    now: clock.monotonic,
  });
  const p = client.request(ADDRESS, 'GetParamList', {}, { timeoutMs: 60_000 });
  p.catch(() => {});
  await run(clock, Promise.race([new Promise((r) => clock.timers.setTimeout(r, 20)), p]));
  const s = net.sockets[0];
  s.emit('data', Buffer.from('{"command":"NotifyList"}\r\n'.repeat(LIMITS.maxOtherLines + 1)));
  await assert.rejects(run(clock, p), (err) => err.kind === ERROR_KINDS.PROTOCOL);
});

test('a timeout closes the connection; the next request opens a new one only after the close', async () => {
  const clock = testClock();
  const net = scriptedSocket(clock);
  const client = new PanelClient({
    connect: net.connect,
    timers: clock.timers,
    now: clock.monotonic,
  });
  const p = client.request(ADDRESS, 'GetParamList', {}, { timeoutMs: 500 });
  await assert.rejects(run(clock, p), (err) => err.kind === ERROR_KINDS.TIMEOUT && err.sent);
  assert.equal(net.sockets[0].closed, true, 'rejected only once closed');
  const q = client.request(ADDRESS, 'GetParamList', {}, { timeoutMs: 500 });
  q.catch(() => {});
  await run(clock, Promise.race([new Promise((r) => clock.timers.setTimeout(r, 20)), q]));
  assert.equal(net.sockets.length, 2);
  await run(clock, q).catch(() => {});
});

test('an abort ends the request and closes the connection before rejecting', async () => {
  const clock = testClock();
  const net = scriptedSocket(clock);
  const client = new PanelClient({
    connect: net.connect,
    timers: clock.timers,
    now: clock.monotonic,
  });
  const controller = new AbortController();
  const p = client.request(
    ADDRESS,
    'GetParamList',
    {},
    { timeoutMs: 60_000, signal: controller.signal },
  );
  p.catch(() => {});
  await run(clock, Promise.race([new Promise((r) => clock.timers.setTimeout(r, 20)), p]));
  controller.abort();
  await assert.rejects(run(clock, p), (err) => err.kind === ERROR_KINDS.ABORTED);
  assert.equal(net.sockets[0].closed, true);
});

test('beforeSend refusing: nothing written; fields built after it', async () => {
  const clock = testClock();
  const net = scriptedSocket(clock);
  const client = new PanelClient({
    connect: net.connect,
    timers: clock.timers,
    now: clock.monotonic,
  });
  const p = client.request(ADDRESS, 'SETPARAMLIST', () => ({ x: 1 }), {
    timeoutMs: 5000,
    beforeSend: () => {
      throw new Error('option off');
    },
  });
  await assert.rejects(
    run(clock, p),
    (err) => err.kind === ERROR_KINDS.YIELDED && !err.sent && err.cause.message === 'option off',
  );
  assert.deepEqual(net.sockets[0].written, []);
  let order = [];
  const q = client.request(ADDRESS, 'SETPARAMLIST', () => (order.push('fields'), { x: 1 }), {
    timeoutMs: 50,
    beforeSend: () => order.push('before'),
  });
  await run(clock, q).catch(() => {});
  assert.deepEqual(order, ['before', 'fields']);
});

test('one request at a time; a refused connection is unreachable', async () => {
  const clock = testClock();
  const net = scriptedSocket(clock);
  const client = new PanelClient({
    connect: net.connect,
    timers: clock.timers,
    now: clock.monotonic,
  });
  const p = client.request(ADDRESS, 'GetParamList', {}, { timeoutMs: 100 });
  p.catch(() => {});
  await assert.rejects(
    client.request(ADDRESS, 'GetParamList', {}, { timeoutMs: 100 }),
    /already in flight/,
  );
  await run(clock, p).catch(() => {});
  const down = scriptedSocket(clock, { refuse: true });
  const other = new PanelClient({
    connect: down.connect,
    timers: clock.timers,
    now: clock.monotonic,
  });
  await assert.rejects(
    run(clock, other.request(ADDRESS, 'GetParamList', {}, { timeoutMs: 100 })),
    (err) => err.kind === ERROR_KINDS.UNREACHABLE && !err.sent,
  );
});
