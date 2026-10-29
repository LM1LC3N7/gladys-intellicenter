// -----------------------------------------------------------------------------
// Review r1: stops for two addresses (each its own check), stops never
// written again sooner than 15 s, a heat stop applied only once the body no
// longer heats, a circuit group behind "heating", /data that hangs, a stop
// clicked without an address, a failed save of a stop tried again, the
// ceiling in °F rounded down, the stop first on the line.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setpointToWrite, ceilingOf } from '../src/ic/model.js';
import { Lane } from '../src/lane.js';
import { memoryStore } from '../src/store.js';
import { HOST, PORT, fakePanel } from './fixtures/fakePanel.js';
import { ALLOW, CFG, ID, MINUTE, SECOND, feature, ok, refused, setup } from './helpers.js';
import { testClock } from './kit/clock.mjs';

const OLD = '192.168.1.59';

/** A panel that answers at HOST only; connections to OLD are counted and refused. */
function twoAddresses(clock) {
  const panel = fakePanel({ timers: clock.timers });
  panel.attempts = new Map();
  panel.hostOk = (host, port) => {
    panel.attempts.set(host, (panel.attempts.get(host) ?? 0) + 1);
    return host === HOST && port === PORT;
  };
  return panel;
}

test('stops kept for two addresses: each address checked on its own, the reachable one written', async () => {
  const clock = testClock();
  const panel = twoAddresses(clock);
  const t = await setup({ config: { host: OLD }, clock, panel, create: false });
  refused(await t.press('circuit-C0001', 'off'), /pas encore envoyé/);
  await t.until(t.app.configUpdated({ host: HOST }));
  await t.advance(2 * SECOND);
  panel.objects.B1202.MODE = '2';
  panel.refuseSet = '400';
  refused(await t.press('heat-mode-B1202', 'off'), /refusé/);
  panel.refuseSet = undefined;
  const before = panel.attempts.get(OLD);
  await t.advance(60 * SECOND, 100);
  assert.equal(panel.objects.B1202.MODE, '1', 'the stop of the new address written again');
  const tries = panel.attempts.get(OLD) - before;
  assert.ok(tries >= 2 && tries <= 10, `${tries} connections to the old address in 60 s`);
  assert.equal(t.app.guards.size, 1, 'the old one kept, never given up');
});

test('a stop never left for the new address goes once the panel answers, whatever the old one', async () => {
  const clock = testClock();
  const panel = twoAddresses(clock);
  const t = await setup({ config: { host: OLD }, clock, panel, create: false });
  refused(await t.press('circuit-C0001', 'off'), /pas encore envoyé/);
  await t.until(t.app.configUpdated({ host: HOST }));
  await t.advance(2 * SECOND);
  panel.objects.C0004.STATUS = 'ON';
  panel.down = true;
  refused(await t.press('circuit-C0004', 'off'), /pas encore envoyé/);
  panel.down = false;
  await t.advance(16 * SECOND, 100);
  assert.equal(panel.objects.C0004.STATUS, 'OFF');
});

test('the same panel read at a new address: its kept stops follow it', async () => {
  const clock = testClock();
  const panel = fakePanel({ timers: clock.timers });
  const store = memoryStore({
    target: { host: OLD, port: PORT, id: ID },
    stops: [
      {
        host: OLD,
        port: PORT,
        objnam: 'C0006',
        attr: 'STATUS',
        value: 'OFF',
        since: 0,
        written: false,
        resends: 0,
      },
    ],
  });
  panel.objects.C0006.STATUS = 'ON';
  const t = await setup({ config: CFG, clock, panel, store, boot: true, create: false });
  await t.advance(20 * SECOND, 100);
  assert.equal(panel.objects.C0006.STATUS, 'OFF');
  assert.equal(t.app.guards.size, 0);
});

test('a heat stop: the mode Off shown while the body still heats is watched, not applied', async () => {
  const t = await setup({ config: CFG });
  t.panel.objects.B1202.HTMODE = '1';
  refused(await t.press('heat-mode-B1202', 'off'), /chauffe encore/);
  assert.equal(t.panel.objects.B1202.MODE, '1');
  assert.equal(t.app.guards.size, 1);
  assert.match(t.status().text, /mode Arrêt affiché, le bassin chauffe encore \(refroidissement\)/);
  const writes = t.panel.sets().length;
  await t.advance(2 * MINUTE + 15 * SECOND, 200);
  assert.match(t.status().text, /vérifiez sur le panneau/);
  assert.equal(t.panel.sets().length, writes, 'the mode is shown Off: nothing written again');
  t.panel.objects.B1202.HTMODE = '0';
  await t.advance(16 * SECOND, 100);
  assert.equal(t.app.guards.size, 0);
});

test('a featured circuit group needs "heating" unless every body is seen with its heat mode off', async () => {
  const t = await setup({ config: { host: HOST, allow_circuits: true } });
  t.panel.objects.C0010 = {
    OBJTYP: 'CIRCUIT',
    SUBTYP: 'CIRCGRP',
    SNAME: 'Spa Mode',
    STATUS: 'OFF',
    FEATR: 'ON',
  };
  await t.advance(31 * SECOND, 100);
  await t.until(t.gladys.fake.deviceCreated(t.gladys.fake.discoveredDevices.at(-1)));
  refused(await t.press('circuit-C0010', 'on'), /peut lancer le chauffage/);
  assert.equal(t.panel.sets().length, 0);
  t.panel.objects.B1202.MODE = '1';
  ok(await t.press('circuit-C0010', 'on'));
  assert.equal(t.panel.objects.C0010.STATUS, 'ON');
});

test('a /data whose load never ends: the stop still goes at once, start and reads go on', async () => {
  const store = memoryStore();
  store.load = () => new Promise(() => {});
  const t = await setup({ config: CFG, store, create: false });
  // Clicked while the load of /data still hangs (given up only after 2 s).
  t.panel.objects.C0004.STATUS = 'ON';
  const start = t.clock.elapsed;
  const ack = t.fire('circuit-C0004', 'off');
  let at;
  ack.then(() => (at = t.clock.elapsed));
  await t.advance(5 * SECOND, 20);
  ok(await ack);
  assert.ok(at - start < SECOND, `${at - start} ms`);
  // Unreadable after 2 s: a whole interval before the first read, then read.
  await t.advance(32 * SECOND, 100);
  assert.equal(t.status().connected, true, 'start not frozen');
  assert.equal(store.saves, 0, 'an unreadable /data is never overwritten');
});

test('the configuration not read and /data hanging: the stop answers at once, kept', async () => {
  const store = memoryStore();
  store.load = () => new Promise(() => {});
  const t = await setup({ config: CFG, store, create: false, getConfigHangs: true });
  const start = t.clock.elapsed;
  const ack = t.fire('circuit-C0004', 'off');
  let at;
  ack.then(() => (at = t.clock.elapsed));
  await t.advance(3 * SECOND, 20);
  refused(await ack, /gardé, envoyé en premier/);
  assert.ok(at - start < SECOND, `${at - start} ms: never waits for /data`);
  assert.equal(t.app.addressless.length, 1);
});

test('a read begun less than 2 s after a write never judges the stop held', async () => {
  const t = await setup({ config: CFG });
  const guard = t.app.newGuard(
    { host: HOST, port: PORT },
    { objnam: 'C0004', attr: 'STATUS', value: 'OFF' },
  );
  const now = t.clock.monotonic();
  Object.assign(guard, { written: true, resends: 3, sentAt: now - 1000 });
  assert.equal(t.app.decideStop(guard, { STATUS: 'ON' }, now), 'wait');
  assert.equal(t.app.decideStop(guard, { STATUS: 'ON' }, now + 1500), 'hold');
});

test('a save that hangs never stops the reads nor a new configuration', async () => {
  const t = await setup({ config: CFG });
  t.store.hang = new Promise(() => {});
  const reads = t.panel.count('GetParamList');
  await t.advance(2 * MINUTE, 200);
  assert.ok(t.panel.count('GetParamList') > reads + 4);
  await t.until(t.app.configUpdated({ host: '192.168.1.61' }));
  assert.deepEqual(t.app.config.address, { host: '192.168.1.61', port: PORT });
});

test('a stop clicked before any address is known is kept and sent first once one is', async () => {
  const t = await setup({ config: {}, create: false });
  t.panel.objects.C0004.STATUS = 'ON';
  refused(await t.press('circuit-C0004', 'off'), /gardé, envoyé en premier/);
  await t.until(t.app.configUpdated({ host: HOST }));
  await t.advance(2 * SECOND, 20);
  assert.equal(t.panel.objects.C0004.STATUS, 'OFF');
  assert.equal(t.panel.sets()[0].message.objectList[0].objnam, 'C0004');
});

test('a save of a stop that failed is tried again', async () => {
  const t = await setup({ config: CFG });
  t.panel.objects.C0004.STATUS = 'ON';
  t.panel.down = true;
  t.store.failSave = true;
  refused(await t.press('circuit-C0004', 'off'), /pas encore envoyé/);
  assert.deepEqual(t.store.data.stops ?? [], []);
  t.store.failSave = false;
  await t.advance(16 * SECOND, 100);
  assert.equal(t.store.data.stops.length, 1, 'saved at the next check');
});

test('a pool ceiling that is no whole °F: the written degree rounded down, never above', () => {
  for (const ceiling of [31, 36]) {
    const c = ceilingOf({ subtype: 'POOL' }, ceiling);
    const w = setpointToWrite(ceiling, 'F', c);
    assert.ok(((Number(w.value) - 32) * 5) / 9 <= ceiling, `${ceiling}: ${w.value}`);
    assert.equal(w.value, String(Math.floor((ceiling * 9) / 5 + 32)));
  }
});

test('the stop goes first on the line, before reads and commands waiting', async () => {
  const lane = new Lane();
  const holder = await lane.acquire('read');
  const order = [];
  const take = (kind) => lane.acquire(kind).then((h) => (order.push(kind), h.release()));
  const all = [take('read'), take('command'), take('check'), take('stop')];
  assert.equal(holder.signal.aborted, true, 'the holder is aborted for the stop');
  holder.release();
  await Promise.all(all);
  assert.deepEqual(order, ['stop', 'command', 'check', 'read']);
  assert.equal(feature('x').endsWith(':x'), true);
  assert.ok(ALLOW);
});
