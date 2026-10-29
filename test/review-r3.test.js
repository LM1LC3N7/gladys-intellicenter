// -----------------------------------------------------------------------------
// Review r3: a command takes the line from a check only (never from a stop),
// a /data read late never replaces a stop of this run nor undoes a command of
// this run that left, the stops of a late /data follow the same panel to its
// new address, a body circuit of no known body refused during a heat stop,
// the answer of a stop found by its setting, a check cut by a command tried
// again a second later.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Lane } from '../src/lane.js';
import { memoryStore } from '../src/store.js';
import { HOST, PORT, fakePanel } from './fixtures/fakePanel.js';
import { ALLOW, ID, SECOND, ok, refused, setup } from './helpers.js';
import { testClock } from './kit/clock.mjs';

const OLD = '192.168.1.59';

/** A stop as /data keeps it. */
const kept = (objnam, extra = {}) => ({
  host: HOST,
  port: PORT,
  objnam,
  attr: 'STATUS',
  value: 'OFF',
  since: 0,
  written: false,
  resends: 0,
  ...extra,
});

/** A store whose load ends `ms` after it is asked (a slow disk), or when `release()` is called. */
function slowStore(clock, data, ms = Infinity) {
  const store = memoryStore(data);
  const load = store.load.bind(store);
  store.load = () =>
    new Promise((resolve) => {
      store.release = () => resolve(load());
      if (Number.isFinite(ms)) clock.timers.setTimeout(store.release, ms);
    });
  return store;
}

/** The writes of a setting: [{ value, at }]. */
const writesOf = (panel, objnam, attr = 'STATUS') =>
  panel
    .sets()
    .flatMap((r) =>
      (r.message.objectList ?? [])
        .filter((o) => o.objnam === objnam && o.params?.[attr] !== undefined)
        .map((o) => ({ value: o.params[attr], at: r.at })),
    );

test('a command takes the line from a check only, never from a stop nor a read', async () => {
  for (const [kind, aborted] of [
    ['check', true],
    ['stop', false],
    ['read', false],
    ['command', false],
  ]) {
    const lane = new Lane();
    const holder = await lane.acquire(kind);
    const next = lane.acquire('command');
    assert.equal(
      holder.signal.aborted,
      aborted,
      `a command arriving while a ${kind} holds the line`,
    );
    holder.release();
    (await next).release();
  }
});

test('a stop on a slow panel: a command clicked 100 ms after never cuts it', async () => {
  const t = await setup({ config: ALLOW });
  t.panel.objects.C0004.STATUS = 'ON';
  t.panel.latencyMs = 300;
  const stop = t.fire('circuit-C0004', 'off');
  await t.advance(100, 10);
  const command = t.fire('circuit-C0003', 'on');
  await t.advance(6 * SECOND, 20);
  ok(await stop);
  await command.catch(() => {});
  assert.equal(writesOf(t.panel, 'C0004').length, 1, 'one write of the stop, never cut');
  assert.equal(t.panel.objects.C0004.STATUS, 'OFF');
});

test('a /data read late never replaces a stop clicked in this run', async () => {
  const clock = testClock();
  const panel = fakePanel({ timers: clock.timers });
  // The file holds the same stop, held (written 3 times without effect before the restart).
  const store = slowStore(
    clock,
    {
      target: { host: HOST, port: PORT, id: ID },
      stops: [kept('C0004', { written: true, resends: 3 })],
    },
    12 * SECOND,
  );
  const t = await setup({ config: { host: HOST }, clock, panel, store, create: false });
  panel.objects.C0004.STATUS = 'ON';
  panel.ignoreSet = true;
  refused(await t.press('circuit-C0004', 'off'), /pas encore appliqué/);
  const guard = [...t.app.guards.values()][0];
  assert.equal(guard.resends, 0);
  await t.advance(8 * SECOND, 50);
  assert.equal(t.app.memoryUnreadable, false, 'the late load applied');
  assert.equal(t.app.guards.get(guard.key), guard, 'the stop of this run kept');
  const before = writesOf(panel, 'C0004').length;
  await t.advance(20 * SECOND, 100);
  assert.ok(writesOf(panel, 'C0004').length > before, 'written again, never held by the file');
});

test('a body circuit of no known body: refused during a heat stop, heating allowed', async () => {
  const t = await setup({ config: { host: HOST, allow_circuits: true, allow_heating: true } });
  t.panel.objects.B1202.HTMODE = '1';
  refused(await t.press('heat-mode-B1202', 'off'), /chauffe encore/);
  // C0001 (a spa circuit) without BODY and no spa body: its body cannot be told.
  delete t.panel.objects.C0001.BODY;
  t.panel.objects.B1202.SUBTYP = 'POOL';
  refused(await t.press('circuit-C0001', 'on'), /arrêt de ce bassin est en cours/);
  assert.equal(t.panel.objects.C0001.STATUS, 'OFF');
});

test('a /data read late never undoes a command of this run that left', async () => {
  const clock = testClock();
  const panel = fakePanel({ timers: clock.timers });
  const store = slowStore(
    clock,
    { target: { host: HOST, port: PORT, id: ID }, stops: [kept('C0004')] },
    20 * SECOND,
  );
  const t = await setup({
    config: { host: HOST, allow_circuits: true },
    clock,
    panel,
    store,
    create: false,
  });
  ok(await t.press('circuit-C0004', 'on'));
  await t.advance(20 * SECOND, 100);
  assert.equal(t.app.memoryUnreadable, false, 'the late load applied');
  assert.equal(panel.objects.C0004.STATUS, 'ON', 'the newer command kept');
  assert.deepEqual(
    writesOf(panel, 'C0004').map((w) => w.value),
    ['ON'],
  );
  assert.equal(t.app.guards.size, 0);
  assert.ok(t.lines.some((l) => /stop kept in \/data for C0004 let go/.test(l)));
  assert.deepEqual(store.data.stops, [], '/data no longer holds it');
});

test('a refused command is no newer intent: the stop of a /data read late still goes', async () => {
  const clock = testClock();
  const panel = fakePanel({ timers: clock.timers });
  const store = slowStore(
    clock,
    { target: { host: HOST, port: PORT, id: ID }, stops: [kept('C0004')] },
    20 * SECOND,
  );
  const t = await setup({
    config: { host: HOST, allow_circuits: true },
    clock,
    panel,
    store,
    create: false,
  });
  panel.refuseSet = '400';
  refused(await t.press('circuit-C0004', 'on'), /400/);
  panel.refuseSet = undefined;
  // Turned on at the panel itself meanwhile.
  panel.objects.C0004.STATUS = 'ON';
  await t.advance(20 * SECOND, 100);
  assert.equal(panel.objects.C0004.STATUS, 'OFF', 'the stop of /data sent');
});

test('a /data read late while a command of the setting is on its way: the stop let go is not written', async () => {
  const clock = testClock();
  const panel = fakePanel({ timers: clock.timers, latencyMs: 300 });
  const store = slowStore(clock, {
    target: { host: HOST, port: PORT, id: ID },
    stops: [kept('C0004')],
  });
  const t = await setup({
    config: { host: HOST, allow_circuits: true },
    clock,
    panel,
    store,
    create: false,
  });
  // The load ends right when the "on" reaches the panel, before its answer.
  panel.onRequest = (message) => {
    const on = message.objectList?.some((o) => o.objnam === 'C0004' && o.params?.STATUS === 'ON');
    if (message.command === 'SETPARAMLIST' && on) store.release();
  };
  await t.press('circuit-C0004', 'on', 10 * SECOND);
  await t.advance(20 * SECOND, 100);
  assert.equal(t.app.memoryUnreadable, false, 'the late load applied');
  assert.equal(panel.objects.C0004.STATUS, 'ON', 'the command that left wins');
  assert.deepEqual(
    writesOf(panel, 'C0004').map((w) => w.value),
    ['ON'],
  );
});

test('a /data read late: the stops of the old address of the same panel follow it', async () => {
  const clock = testClock();
  const panel = fakePanel({ timers: clock.timers });
  panel.attempts = new Map();
  panel.hostOk = (host, port) => {
    panel.attempts.set(host, (panel.attempts.get(host) ?? 0) + 1);
    return host === HOST && port === PORT;
  };
  panel.objects.C0006.STATUS = 'ON';
  // Read late, after the first read of this run at the new address.
  const store = slowStore(
    clock,
    {
      target: { host: OLD, port: PORT, id: ID },
      stops: [kept('C0006', { host: OLD })],
    },
    45 * SECOND,
  );
  const t = await setup({ config: { host: HOST }, clock, panel, store, create: false });
  await t.advance(40 * SECOND, 100);
  assert.ok(panel.count('GetParamList') > 0, 'read at the new address before the load');
  assert.equal(panel.objects.C0006.STATUS, 'ON');
  await t.advance(5 * SECOND, 50);
  assert.equal(t.app.memoryUnreadable, false, 'the late load applied');
  await t.advance(2 * SECOND, 50);
  assert.equal(panel.objects.C0006.STATUS, 'OFF', 'sent to the new address at once');
  assert.equal(panel.attempts.get(OLD) ?? 0, 0, 'never to the old one');
  assert.equal(t.app.guards.size, 0);
});

test('a command that left before a /data read at the start: the stop of /data let go and forgotten', async () => {
  const store = memoryStore({
    target: { host: HOST, port: PORT, id: ID },
    stops: [kept('C0004')],
  });
  // boot() not yet run: the command leaves first (boot and connect run together).
  const t = await setup({ config: { host: HOST, allow_circuits: true }, store, create: false });
  ok(await t.press('circuit-C0004', 'on'));
  await t.app.boot();
  await t.advance(2 * SECOND, 50);
  assert.equal(t.panel.objects.C0004.STATUS, 'ON');
  assert.equal(t.app.guards.size, 0);
  assert.deepEqual(store.data.stops, [], 'a restart never sends it again');
});

test('a stop that follows the panel to its new address while it is sent answers its real result', async () => {
  const clock = testClock();
  const panel = fakePanel({ timers: clock.timers });
  // The same panel answers at OLD, then only at HOST (DHCP).
  panel.hostOk = (host, port) => (host === OLD || host === HOST) && port === PORT;
  const t = await setup({ config: { host: OLD }, clock, panel, create: false });
  await t.advance(SECOND);
  assert.equal(t.app.memory.target?.host, OLD);
  panel.hostOk = (host, port) => host === HOST && port === PORT;
  panel.objects.C0004.STATUS = 'ON';
  const ack = t.fire('circuit-C0004', 'off');
  await t.advance(100, 10);
  // Read at the new address while the stop still tries the old one: the stop follows the panel.
  t.app.configUpdated({ host: HOST });
  await t.advance(SECOND, 10);
  const guard = [...t.app.guards.values()][0];
  assert.equal(guard.target.host, HOST, 'the stop moved during its send');
  await t.advance(4 * SECOND, 20);
  refused(await ack, /pas encore envoyé/);
  await t.advance(10 * SECOND, 100);
  assert.equal(panel.objects.C0004.STATUS, 'OFF', 'then written at the new address');
});

test('a check cut by a command is tried again a second later', async () => {
  const t = await setup({ config: { host: HOST, allow_heating: true } });
  t.panel.objects.C0004.STATUS = 'ON';
  t.panel.down = true;
  refused(await t.press('circuit-C0004', 'off'), /pas encore envoyé/);
  t.panel.down = false;
  // The check of the stop reads slowly; a command arrives during that read.
  let slow = true;
  t.panel.latencyMs = () => (slow ? 3 * SECOND : 5);
  const isCheck = (r) =>
    r.command === 'GetParamList' &&
    r.message.objectList?.length === 1 &&
    r.message.objectList[0].objnam === 'C0004';
  for (let e = 0; e < 20 * SECOND && !t.panel.requests.some(isCheck); e += 10) {
    await t.advance(10, 10);
  }
  assert.ok(t.panel.requests.some(isCheck), 'the check read');
  slow = false;
  let answeredAt;
  const ack = t.fire('setpoint-B1101', 28);
  ack.then(() => (answeredAt = t.clock.elapsed));
  for (let e = 0; e < 10 * SECOND && writesOf(t.panel, 'C0004').length === 0; e += 10) {
    await t.advance(10, 10);
  }
  ok(await ack);
  const writes = writesOf(t.panel, 'C0004');
  assert.equal(writes.length, 1, 'the stop written by the check');
  assert.ok(
    writes[0].at - answeredAt <= 2 * SECOND,
    `${writes[0].at - answeredAt} ms after the command`,
  );
  assert.equal(t.panel.objects.C0004.STATUS, 'OFF');
});
