// -----------------------------------------------------------------------------
// The guards checked twice (on the fresh read and right before the byte), the
// counts of a stop, its retries, and the reads that judge it: each one proven
// by a case where it alone decides.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { memoryStore } from '../src/store.js';
import { HOST, PORT, fakePanel } from './fixtures/fakePanel.js';
import { ALLOW, CFG, ID, MINUTE, SECOND, feature, ok, refused, setup } from './helpers.js';
import { testClock } from './kit/clock.mjs';

const objectsGet = (m) =>
  m.command === 'GetParamList' && !m.condition && m.objectList?.[0]?.objnam !== 'INCR';

/** The panel closes the connection after the fresh read; the next one takes `ms` to open. */
function reconnectBeforeWrite(t, ms) {
  t.panel.closeAfterAnswer = (m) => objectsGet(m) && t.panel.sets().length === 0;
  t.panel.connectMs = ms;
}

test('an option turned off while the write reconnects: refused right before the byte', async () => {
  const t = await setup({ config: ALLOW });
  reconnectBeforeWrite(t, 800);
  const ack = t.fire('circuit-C0004', 'on');
  await t.advance(300);
  await t.app.configUpdated({ ...ALLOW, allow_circuits: false });
  await t.advance(4000, 50);
  refused(await ack, /circuits et pompes.*pas autorisées/);
  assert.equal(t.panel.sets().length, 0);
});

test('the deadline passed while the write reconnects: nothing sent', async () => {
  const t = await setup({ config: ALLOW });
  t.panel.latencyMs = 1200;
  // Open at 3.7 s: before the request times out, after the 3.5 s deadline.
  reconnectBeforeWrite(t, 1300);
  const ack = t.fire('circuit-C0004', 'on');
  await t.advance(6000, 50);
  refused(await ack, /à temps : rien envoyé/);
  assert.equal(t.panel.sets().length, 0);
});

test('a command waiting for the line when a stop is clicked never leaves after it', async () => {
  const t = await setup({ config: ALLOW });
  t.panel.objects.C0004.STATUS = 'ON';
  // A read holds the line.
  const read = await t.app.lane.acquire('read');
  const on = t.fire('circuit-C0003', 'on');
  await t.advance(100);
  const off = t.fire('circuit-C0004', 'off');
  await t.advance(50);
  read.release();
  await t.advance(5000, 50);
  refused(await on, /arrêt a été cliqué/);
  ok(await off);
  assert.equal(t.panel.objects.C0003.STATUS, 'OFF');
  assert.ok(
    t.panel.sets().every((r) => r.message.objectList.every((o) => o.params.STATUS === 'OFF')),
  );
});

test('a command still in its gathering when a stop is clicked is answered at once', async () => {
  const t = await setup({ config: ALLOW });
  const on = t.fire('circuit-C0003', 'on');
  let at;
  on.then(() => (at = t.clock.elapsed));
  await t.advance(2);
  const clicked = t.clock.elapsed;
  t.fire('circuit-C0004', 'off');
  await t.advance(5000, 2);
  refused(await on, /arrêt a été cliqué/);
  assert.ok(at - clicked < 15, `${at - clicked} ms`);
});

test('a command cut on its way by a stop never lets that stop go', async () => {
  const t = await setup({ config: ALLOW });
  // The command is applied, its answer never comes.
  t.panel.silentSet = 'applied';
  const on = t.fire('circuit-C0004', 'on');
  await t.advance(200);
  assert.equal(t.panel.sets().length, 1, 'the command left');
  assert.equal(t.panel.objects.C0004.STATUS, 'ON');
  // The stop is accepted but not applied: it must stay kept.
  t.panel.silentSet = false;
  t.panel.ignoreSet = true;
  const off = t.fire('circuit-C0004', 'off');
  await t.advance(5000, 50);
  refused(await on, /sans confirmation/);
  refused(await off, /pas encore appliqué/);
  assert.equal(t.app.guards.size, 1, 'kept');
  t.panel.ignoreSet = false;
  await t.advance(20 * SECOND, 100);
  assert.equal(t.panel.objects.C0004.STATUS, 'OFF');
});

test('a stop retried within its 3 s: the panel back after 600 ms, confirmed in the ack', async () => {
  const t = await setup({ config: CFG });
  t.panel.objects.C0004.STATUS = 'ON';
  t.panel.down = true;
  t.clock.timers.setTimeout(() => (t.panel.down = false), 600);
  ok(await t.press('circuit-C0004', 'off'));
  assert.equal(t.panel.objects.C0004.STATUS, 'OFF');
});

test('a stop first written by a check counts no resend for that write', async () => {
  const t = await setup({ config: CFG });
  t.panel.objects.C0004.STATUS = 'ON';
  t.panel.down = true;
  refused(await t.press('circuit-C0004', 'off'), /pas encore envoyé/);
  t.panel.down = false;
  t.panel.ignoreSet = true;
  await t.advance(3 * MINUTE, 200);
  assert.equal(t.panel.sets().length, 4, 'the first write and 3 resends');
  assert.match(t.status().text, /tenu/);
});

test('a restart writing a stop written before counts it as a resend', async () => {
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
    ],
  });
  const clock = testClock();
  const panel = fakePanel({ timers: clock.timers });
  panel.objects.C0004.STATUS = 'ON';
  panel.ignoreSet = true;
  const t = await setup({ config: CFG, store, boot: true, clock, panel, getConfigHangs: true });
  assert.equal(panel.sets().length, 1);
  assert.equal([...t.app.guards.values()][0].resends, 2);
});

test('a read after a stop that shows it not applied writes it again at once', async () => {
  const t = await setup({ config: CFG });
  t.panel.objects.C0004.STATUS = 'ON';
  t.panel.ignoreSet = true;
  refused(await t.press('circuit-C0004', 'off', 4400), /pas encore appliqué/);
  t.panel.ignoreSet = false;
  // The follow-up read 5 s after the write sees it not applied: written again then, not at 15 s.
  await t.advance(2 * SECOND, 50);
  assert.equal(t.panel.objects.C0004.STATUS, 'OFF');
});

test('a restart: the test button never reads sooner than the interval', async () => {
  const store = memoryStore();
  await setup({ config: CFG, store });
  const clock = testClock({ start: store.data.lastAttemptAt + 5 * SECOND });
  const panel = fakePanel({ timers: clock.timers });
  const u = await setup({ config: CFG, store, clock, panel, create: false });
  const answer = await u.until(u.app.testConnection());
  assert.match(answer.fr, /jamais avant l'intervalle/);
  assert.equal(panel.count('GetParamList'), 0);
});

test('values read more than 2 minutes ago are not sent to a device created now', async () => {
  const t = await setup({ config: { ...CFG, poll_interval: 600 }, create: false });
  await t.advance(3 * MINUTE, 1000);
  const count = t.gladys.fake.states.length;
  await t.until(t.gladys.fake.deviceCreated(t.gladys.fake.discoveredDevices[0]));
  await t.advance(2 * SECOND);
  const sent = t.gladys.fake.states.slice(count).map((s) => s.device_feature_external_id);
  assert.ok(!sent.includes(feature('circuit-C0006')), sent.join(','));
});

test('a check gives way, right before its write, to a command clicked during its read', async () => {
  const t = await setup({ config: ALLOW });
  t.panel.objects.C0004.STATUS = 'ON';
  t.panel.ignoreSet = true;
  refused(await t.press('circuit-C0004', 'off', 4400), /pas encore appliqué/);
  let on;
  let mark;
  t.panel.latencyMs = 300;
  t.panel.onRequest = (m) => {
    if (on || !objectsGet(m)) return;
    // The read of the check: a newer command arrives while it is on its way.
    t.panel.ignoreSet = false;
    mark = t.panel.sets().length;
    on = t.fire('circuit-C0004', 'on');
  };
  await t.advance(20 * SECOND, 50);
  ok(await on);
  const after = t.panel
    .sets()
    .slice(mark)
    .map((r) => r.message.objectList[0].params.STATUS);
  assert.deepEqual(after, ['ON'], 'the old stop never written after the command was clicked');
  assert.equal(t.panel.objects.C0004.STATUS, 'ON');
  assert.equal(t.app.guards.size, 0);
});
