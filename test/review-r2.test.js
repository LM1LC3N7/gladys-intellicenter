// -----------------------------------------------------------------------------
// Review r2: a /data read late is applied (its stops sent), a body "heats"
// while its heat mode is not seen Off or heating is still reported, circuit
// groups during a heat stop and before any read, an unreadable heating state
// said, a dead old address never making a command miss its turn.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryStore } from '../src/store.js';
import { HOST, PORT, fakePanel } from './fixtures/fakePanel.js';
import { ID, SECOND, ok, refused, setup } from './helpers.js';
import { testClock } from './kit/clock.mjs';

const GROUP = {
  OBJTYP: 'CIRCUIT',
  SUBTYP: 'CIRCGRP',
  SNAME: 'Spa Mode',
  STATUS: 'OFF',
  FEATR: 'ON',
};

test('a /data read in 3 s: applied when it arrives, its stop sent, /data written again', async () => {
  const clock = testClock();
  const panel = fakePanel({ timers: clock.timers });
  panel.objects.C0006.STATUS = 'ON';
  const store = memoryStore({
    target: { host: HOST, port: PORT, id: ID },
    stops: [
      {
        host: HOST,
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
  const load = store.load.bind(store);
  store.load = () => new Promise((resolve) => clock.timers.setTimeout(() => resolve(load()), 3000));
  const t = await setup({ config: { host: HOST }, clock, panel, store, create: false });
  const booted = t.app.boot();
  await t.advance(4 * SECOND, 20);
  await booted;
  assert.equal(panel.objects.C0006.STATUS, 'OFF', 'the stop of /data sent');
  assert.equal(t.app.memoryUnreadable, false);
  await t.advance(2 * SECOND, 20);
  assert.ok(store.saves > 0, '/data written again');
  assert.deepEqual(store.data.stops, []);
});

test('a body circuit: refused during the heat stop of its body, even when the mode Off is shown', async () => {
  const t = await setup({ config: { host: HOST, allow_circuits: true, allow_heating: true } });
  t.panel.objects.B1202.HTMODE = '1';
  refused(await t.press('heat-mode-B1202', 'off'), /chauffe encore/);
  refused(await t.press('circuit-C0001', 'on'), /arrêt de ce bassin est en cours/);
  refused(await t.press('circuit-C0010', 'on'), /n'affiche pas|arrêt de ce bassin/);
  assert.equal(t.panel.objects.C0001.STATUS, 'OFF');
});

test('a body circuit heats while heating is reported, even with the mode Off', async () => {
  const t = await setup({ config: { host: HOST, allow_circuits: true } });
  t.panel.objects.B1202.MODE = '1';
  t.panel.objects.B1202.HTMODE = '1';
  refused(await t.press('circuit-C0001', 'on'), /peut lancer le chauffage/);
  delete t.panel.objects.B1202.HTMODE;
  refused(await t.press('circuit-C0001', 'on'), /peut lancer le chauffage/);
  t.panel.objects.B1202.HTMODE = '0';
  ok(await t.press('circuit-C0001', 'on'));
});

test('a circuit group: refused during a heat stop, heating allowed or not', async () => {
  const t = await setup({ config: { host: HOST, allow_circuits: true, allow_heating: true } });
  t.panel.objects.C0010 = { ...GROUP };
  t.panel.ignoreSet = true;
  refused(await t.press('heat-mode-B1202', 'off'), /pas encore appliqué/);
  t.panel.ignoreSet = false;
  refused(await t.press('circuit-C0010', 'on', SECOND), /arrêt de ce bassin est en cours/);
  assert.equal(t.panel.objects.C0010.STATUS, 'OFF');
});

test('a circuit group before any read: heating needed', async () => {
  const store = memoryStore({ lastAttemptAt: Date.UTC(2026, 6, 15, 10, 0, 0) - 1000 });
  const clock = testClock({ start: Date.UTC(2026, 6, 15, 10, 0, 0) });
  const panel = fakePanel({ timers: clock.timers });
  panel.objects.C0010 = { ...GROUP };
  panel.objects.B1101.MODE = '1';
  panel.objects.B1202.MODE = '1';
  const t = await setup({
    config: { host: HOST, allow_circuits: true },
    clock,
    panel,
    store,
    create: false,
  });
  assert.equal(panel.count('GetParamList'), 0, 'not read yet');
  refused(await t.press('circuit-C0010', 'on'), /peut lancer le chauffage/);
  assert.equal(panel.sets().length, 0);
});

test('a heat stop whose heating state cannot be read: said as such', async () => {
  const t = await setup({ config: { host: HOST } });
  delete t.panel.objects.B1202.HTMODE;
  refused(await t.press('heat-mode-B1202', 'off'), /chauffe encore/);
  assert.match(t.status().text, /état de chauffe est illisible : vérifiez sur le panneau/);
});

test('the check of a dead old address never makes a command miss its turn', async () => {
  const clock = testClock();
  const panel = fakePanel({ timers: clock.timers });
  const OLD = '192.168.1.59';
  // The old address accepts the connection and never answers (another device there).
  const old = fakePanel({ timers: clock.timers, silent: true, hostOk: () => true });
  const connect = panel.connect;
  panel.connect = (o) => (o.host === OLD ? old.connect(o) : connect(o));
  const store = memoryStore({
    stops: [
      {
        host: OLD,
        port: PORT,
        objnam: 'C0001',
        attr: 'STATUS',
        value: 'OFF',
        since: 0,
        written: false,
        resends: 0,
      },
    ],
  });
  const t = await setup({
    config: { host: HOST, allow_circuits: true, allow_heating: true },
    clock,
    panel,
    store,
    boot: false,
  });
  t.app.adoptStops(t.app.memory.stops);
  // The stop itself tries its 3 s first (a stop goes before commands).
  await t.advance(4 * SECOND, 50);
  let missed = 0;
  for (let k = 0; k < 24; k += 1) {
    const ack = await t.press('setpoint-B1101', 20 + (k % 10), 4500);
    if (!ack.success) missed += 1;
  }
  assert.equal(missed, 0, `${missed} commands missed`);
  assert.equal(t.app.guards.size, 1, 'the old stop still kept');
});
