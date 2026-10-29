// -----------------------------------------------------------------------------
// The stops (a circuit off, a heat mode off) are never held back: options
// off, a stuck read, commands waiting, a panel down, a refusal, /data hung,
// the configuration not read, a restart. A stop that never left is never
// given up; one the panel accepts without effect is written 3 more times,
// then held (said in the status) until the panel shows it, a new click, or a
// newer command that left.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryStore } from '../src/store.js';
import { HOST, PORT } from './fixtures/fakePanel.js';
import { ALLOW, CFG, ID, MINUTE, SECOND, ok, refused, setup } from './helpers.js';

const setsOf = (panel) => panel.sets().map((r) => r.message.objectList);

test('a circuit off and a heat mode off work with every option off', async () => {
  const t = await setup({ config: CFG });
  t.panel.objects.C0004.STATUS = 'ON';
  const start = t.clock.elapsed;
  const ack = t.fire('circuit-C0004', 'off');
  let at;
  ack.then(() => (at = t.clock.elapsed));
  await t.advance(5000, 20);
  ok(await ack);
  assert.ok(at - start < 4300, `${at - start} ms`);
  assert.equal(t.panel.objects.C0004.STATUS, 'OFF');
  ok(await t.press('heat-mode-B1202', 'off'));
  assert.equal(t.panel.objects.B1202.MODE, '1');
  assert.equal(t.app.guards.size, 0);
  assert.deepEqual(t.store.data.stops, []);
});

test('a stop cuts a stuck read (not a failure) and goes on a new connection', async () => {
  const t = await setup({ config: CFG });
  t.panel.objects.C0004.STATUS = 'ON';
  t.panel.latencyMs = (command) => (command === 'SETPARAMLIST' ? 5 : 60 * SECOND);
  // The next poll is stuck on a silent read.
  await t.advance(31 * SECOND, 100);
  assert.equal(t.app.lane.holder?.kind, 'read');
  t.panel.latencyMs = (command) =>
    command === 'SETPARAMLIST' ? 5 : t.app.lane.holder ? 5 : 60 * SECOND;
  ok(await t.press('circuit-C0004', 'off', 4300));
  assert.equal(t.panel.objects.C0004.STATUS, 'OFF');
  assert.ok(t.panel.peak <= 1, 'never two connections at once');
  assert.equal(t.app.panel.online, true, 'the cut read is not a failure');
});

test('a command clicked before a stop and not left never leaves after it', async () => {
  const t = await setup({ config: ALLOW });
  t.panel.latencyMs = 300;
  const on = t.fire('circuit-C0004', 'on');
  await t.advance(20);
  const off = t.fire('circuit-C0004', 'off');
  await t.advance(6000, 50);
  refused(await on, /arrêt a été cliqué/);
  ok(await off);
  assert.equal(t.panel.objects.C0004.STATUS, 'OFF');
  const writes = setsOf(t.panel);
  assert.deepEqual(writes, [[{ objnam: 'C0004', params: { STATUS: 'OFF' } }]]);
});

test('a stop cutting a command on its way: the command is not left after it', async () => {
  const t = await setup({ config: ALLOW });
  t.panel.latencyMs = 600;
  const on = t.fire('circuit-C0004', 'on');
  await t.advance(700);
  const off = t.fire('circuit-C0004', 'off');
  await t.advance(6000, 50);
  refused(await on, /arrêt a été cliqué/);
  ok(await off);
  assert.equal(t.panel.objects.C0004.STATUS, 'OFF');
  assert.ok(setsOf(t.panel).every((w) => w[0].params.STATUS === 'OFF'));
});

test('a panel down: the stop is kept, never given up, sent once the panel answers', async () => {
  const t = await setup({ config: CFG });
  t.panel.objects.C0004.STATUS = 'ON';
  t.panel.down = true;
  refused(await t.press('circuit-C0004', 'off'), /pas encore envoyé/);
  assert.equal(t.store.data.stops.length, 1);
  assert.equal(t.store.data.stops[0].written, false);
  assert.match(t.status().text, /Arrêt \(arrêt\) de Cleaner : pas encore envoyé/);
  await t.advance(10 * MINUTE, 500);
  assert.equal(t.app.guards.size, 1, 'never given up');
  assert.equal([...t.app.guards.values()][0].resends, 0, 'nothing left: no try counted');
  t.panel.down = false;
  await t.advance(16 * SECOND, 100);
  assert.equal(t.panel.objects.C0004.STATUS, 'OFF');
  assert.equal(t.app.guards.size, 0);
  assert.deepEqual(t.store.data.stops, []);
});

test('accepted without effect: written 3 more times, then held, said; let go when shown', async () => {
  const t = await setup({ config: CFG });
  t.panel.objects.C0004.STATUS = 'ON';
  t.panel.ignoreSet = true;
  refused(await t.press('circuit-C0004', 'off'), /pas encore appliqué/);
  await t.advance(2 * MINUTE, 200);
  assert.equal(t.panel.sets().length, 4, 'the click and 3 resends');
  const guard = [...t.app.guards.values()][0];
  assert.equal(guard.resends, 3);
  assert.match(t.status().text, /écrit 4 fois sans effet : tenu/);
  await t.advance(5 * MINUTE, 500);
  assert.equal(t.panel.sets().length, 4, 'held: no more writes, never let go by time');
  assert.equal(t.app.guards.size, 1);
  // A new click: written again, counted anew.
  t.fire('circuit-C0004', 'off');
  await t.advance(5 * SECOND, 50);
  assert.equal(t.panel.sets().length, 5);
  assert.equal(guard.resends, 0);
  // The panel shows it (switched off at the panel): let go at the next read.
  t.panel.objects.C0004.STATUS = 'OFF';
  await t.advance(31 * SECOND, 200);
  assert.equal(t.app.guards.size, 0);
});

test('a stop refused by the panel: kept, written again later and later, never held by refusals', async () => {
  const t = await setup({ config: { ...CFG, poll_interval: 600 } });
  t.panel.objects.C0004.STATUS = 'ON';
  t.panel.refuseSet = '403';
  refused(await t.press('circuit-C0004', 'off'), /Arrêt refusé par le panneau \(refused \(403\)\)/);
  assert.match(t.status().text, /refusé par le panneau \(403\)/);
  const reads = t.panel.count('GetParamList');
  await t.advance(10 * MINUTE, 500);
  const guard = [...t.app.guards.values()][0];
  assert.equal(guard.resends, 0);
  const times = t.panel.sets().map((r) => r.at);
  const gaps = times.slice(1).map((x, k) => x - times[k]);
  // 15 s, 30 s, 60 s, 120 s, 240 s, then 300 s: spaced, never given up.
  assert.ok(
    gaps.every((g, k) => k === 0 || g >= gaps[k - 1] - 100),
    gaps.join(','),
  );
  assert.ok(
    gaps[0] >= 15 * SECOND - 100 && gaps.at(-1) <= 5 * MINUTE + 15 * SECOND,
    gaps.join(','),
  );
  assert.ok(times.length >= 5 && times.length <= 8, `${times.length} writes`);
  // Reads: the checks (every 15 s), the reads after the click; no full read sooner than the interval.
  const full = t.panel.requests.filter((r) => r.message.objectList?.[0]?.objnam === 'INCR');
  assert.ok(full.length <= 6, `${full.length} full reads in 10 min`);
  assert.ok(t.panel.count('GetParamList') - reads < 2 * 45, 'about one check read every 15 s');
  t.panel.refuseSet = undefined;
  await t.advance(6 * MINUTE, 500);
  assert.equal(t.panel.objects.C0004.STATUS, 'OFF');
  assert.equal(t.app.guards.size, 0);
});

test('a newer command that left lets the kept stop go', async () => {
  const t = await setup({ config: ALLOW });
  t.panel.objects.C0004.STATUS = 'ON';
  t.panel.ignoreSet = true;
  refused(await t.press('circuit-C0004', 'off'), /pas encore appliqué/);
  t.panel.ignoreSet = false;
  t.panel.objects.C0004.STATUS = 'OFF';
  ok(await t.press('circuit-C0004', 'on'));
  assert.equal(t.app.guards.size, 0, 'let go');
  const before = t.panel.sets().length;
  await t.advance(MINUTE, 200);
  assert.equal(t.panel.sets().length, before, 'never countered');
  assert.equal(t.panel.objects.C0004.STATUS, 'ON');
});

test('a newer command never sent does not let the stop go', async () => {
  const t = await setup({ config: { ...ALLOW, allow_circuits: false } });
  t.panel.objects.C0004.STATUS = 'ON';
  t.panel.ignoreSet = true;
  refused(await t.press('circuit-C0004', 'off'), /pas encore appliqué/);
  refused(await t.press('circuit-C0004', 'on'), /pas autorisées/);
  assert.equal(t.app.guards.size, 1);
});

test('a set point during a heat stop not seen applied is refused', async () => {
  const t = await setup({ config: ALLOW });
  t.panel.ignoreSet = true;
  refused(await t.press('heat-mode-B1202', 'off'), /pas encore appliqué/);
  refused(await t.press('setpoint-B1202', 30, SECOND), /arrêt de ce bassin est en cours/);
  refused(await t.press('circuit-C0001', 'on', SECOND), /arrêt de ce bassin est en cours/);
  assert.ok(
    setsOf(t.panel).every((w) => w.length === 1 && w[0].params.MODE === '1'),
    'only the stop is written',
  );
});

test('several stops clicked together go in one write', async () => {
  const t = await setup({ config: CFG });
  for (const c of ['C0003', 'C0004', 'C0006']) t.panel.objects[c].STATUS = 'ON';
  t.panel.latencyMs = 200;
  t.app.lane.acquire('read').then((h) => t.clock.timers.setTimeout(() => h.release(), 50));
  const acks = ['C0003', 'C0004', 'C0006'].map((c) => t.fire(`circuit-${c}`, 'off'));
  await t.advance(5000, 20);
  for (const ack of acks) ok(await ack);
  for (const c of ['C0003', 'C0004', 'C0006']) assert.equal(t.panel.objects[c].STATUS, 'OFF');
  assert.ok(t.panel.sets().length <= 2);
});

test('a /data that hangs never holds a stop back', async () => {
  const t = await setup({ config: CFG });
  t.panel.objects.C0004.STATUS = 'ON';
  t.store.hang = new Promise(() => {});
  ok(await t.press('circuit-C0004', 'off'));
  assert.equal(t.panel.objects.C0004.STATUS, 'OFF');
  // A second one right after: never queued behind the first save.
  t.panel.objects.C0003.STATUS = 'ON';
  ok(await t.press('circuit-C0003', 'off'));
  assert.equal(t.panel.objects.C0003.STATUS, 'OFF');
});

test('a restart sends a kept stop before the configuration; a held one is only checked', async () => {
  const store = memoryStore({
    target: { host: HOST, port: PORT, id: ID },
    stops: [
      {
        host: HOST,
        port: PORT,
        objnam: 'C0004',
        attr: 'STATUS',
        value: 'OFF',
        since: 0,
        written: true,
        resends: 1,
      },
      {
        host: HOST,
        port: PORT,
        objnam: 'C0003',
        attr: 'STATUS',
        value: 'OFF',
        since: 0,
        written: true,
        resends: 3,
      },
      {
        host: HOST,
        port: PORT,
        objnam: 'B1202',
        attr: 'MODE',
        value: '1',
        since: 0,
        written: false,
        resends: 2,
      },
    ],
  });
  const t = await setup({ config: CFG, store, boot: true, getConfigHangs: true });
  const writes = setsOf(t.panel);
  assert.equal(writes.length, 1, 'sent before getConfig answered');
  assert.deepEqual(writes[0], [
    { objnam: 'C0004', params: { STATUS: 'OFF' } },
    { objnam: 'B1202', params: { MODE: '1' } },
  ]);
  assert.equal(t.panel.objects.B1202.MODE, '1');
  assert.equal(
    t.panel.objects.C0003.STATUS,
    'OFF',
    'already off: the held one is let go by its check',
  );
  await t.advance(20 * SECOND, 100);
  assert.equal(t.app.guards.size, 0);
  assert.equal(setsOf(t.panel).length, 1, 'the held stop never written by a restart');
});

test('getConfig failing: a stop still goes to the address kept in /data', async () => {
  const store = memoryStore({ target: { host: HOST, port: PORT, id: ID }, stops: [] });
  const t = await setup({ config: CFG, store, getConfigFails: 100, create: false });
  assert.match(t.status().text, /configuration ne peut pas être lue/);
  t.panel.objects.C0004.STATUS = 'ON';
  ok(await t.press('circuit-C0004', 'off'));
  assert.equal(t.panel.objects.C0004.STATUS, 'OFF');
});

test('no address at all: the stop says so', async () => {
  const t = await setup({ config: {}, create: false });
  refused(await t.press('circuit-C0004', 'off'), /Aucune adresse de panneau/);
});

test('a heat stop not applied: written again; a late command on its way countered', async () => {
  const t = await setup({ config: ALLOW });
  // A heat source asked, cut by the panel (it may land late), then the stop.
  t.panel.dropSet = 'before';
  refused(await t.press('heat-mode-B1101', 'heater'), /sans confirmation/);
  t.panel.dropSet = undefined;
  ok(await t.press('heat-mode-B1101', 'off'));
  assert.equal(t.app.guards.size, 1, 'watched for the late command');
  // The late command lands.
  t.panel.objects.B1101.MODE = '2';
  await t.advance(20 * SECOND, 100);
  assert.equal(t.panel.objects.B1101.MODE, '1', 'countered');
  await t.advance(40 * SECOND, 100);
  assert.equal(t.app.guards.size, 0);
});

test('a kept stop never sent goes at once on "Test the connection"', async () => {
  const t = await setup({ config: CFG });
  t.panel.objects.C0004.STATUS = 'ON';
  t.panel.down = true;
  refused(await t.press('circuit-C0004', 'off', 4400), /pas encore envoyé/);
  t.panel.down = false;
  const answer = t.app.testConnection();
  await t.advance(2 * SECOND, 20);
  await answer;
  assert.equal(t.panel.objects.C0004.STATUS, 'OFF', 'sent before the 15 s check');
});

test('a stop on one circuit: a command waiting for another one gives way too', async () => {
  const t = await setup({ config: ALLOW });
  t.panel.objects.C0006.STATUS = 'ON';
  t.panel.latencyMs = 300;
  const on = t.fire('circuit-C0004', 'on');
  await t.advance(10);
  const off = t.fire('circuit-C0006', 'off');
  await t.advance(6000, 50);
  refused(await on, /arrêt a été cliqué/);
  ok(await off);
  assert.equal(t.panel.objects.C0004.STATUS, 'OFF');
});
