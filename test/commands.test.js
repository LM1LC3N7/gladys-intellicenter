// -----------------------------------------------------------------------------
// The commands that start something (a circuit on, a heat source, a set
// point): off by default, each behind its option, checked again right before
// the byte, decided on a fresh read, bounded on the degree written,
// confirmed only by a read back, several in one write (a scene).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ALLOW, CFG, SECOND, ok, refused, setup } from './helpers.js';
import { HOST } from './fixtures/fakePanel.js';

const lastSet = (panel) => panel.sets().at(-1)?.message.objectList;

test('every command that starts something is refused by default; nothing written', async () => {
  const t = await setup({ config: CFG });
  refused(await t.press('circuit-C0004', 'on'), /circuits et pompes.*pas autorisées/);
  refused(await t.press('circuit-C0003', 'on'), /éclairages.*pas autorisées/);
  refused(await t.press('heat-mode-B1202', 'heater'), /chauffage.*pas autorisées/);
  refused(await t.press('setpoint-B1101', 28), /chauffage.*pas autorisées/);
  assert.equal(t.panel.sets().length, 0);
  assert.match(
    t.status().text,
    /Non autorisé depuis Gladys : circuits et pompes, éclairages, chauffage/,
  );
});

test('a light needs "lights" only, a circuit "circuits" only', async () => {
  const t = await setup({ config: { host: HOST, allow_lights: true } });
  ok(await t.press('circuit-C0003', 'on'));
  assert.equal(t.panel.objects.C0003.STATUS, 'ON');
  refused(await t.press('circuit-C0004', 'on'), /circuits et pompes/);
  const u = await setup({ config: { host: HOST, allow_circuits: true } });
  ok(await u.press('circuit-C0004', 'on'));
  refused(await u.press('circuit-C0003', 'on'), /éclairages/);
});

test('a body circuit whose heat mode is not off needs "heating" too', async () => {
  const t = await setup({ config: { host: HOST, allow_circuits: true } });
  // The spa (C0001, body B1202) heats with its heater: refused.
  refused(await t.press('circuit-C0001', 'on'), /peut lancer le chauffage/);
  assert.equal(t.panel.sets().length, 0);
  // Its heat mode off at the panel: allowed (decided on the fresh read).
  t.panel.objects.B1202.MODE = '1';
  ok(await t.press('circuit-C0001', 'on'));
  assert.equal(t.panel.objects.C0001.STATUS, 'ON');
  // The heat mode cannot be read: in doubt, heating needed.
  t.panel.objects.C0001.STATUS = 'OFF';
  delete t.panel.objects.B1202.MODE;
  refused(await t.press('circuit-C0001', 'on'), /peut lancer le chauffage/);
});

test('an option turned off between the fresh read and the write: nothing written', async () => {
  const t = await setup({ config: ALLOW });
  // A slow panel: the configuration arrives while the fresh read is on its way.
  t.panel.latencyMs = 300;
  const ack = t.fire('circuit-C0004', 'on');
  await t.advance(400);
  await t.app.configUpdated({ ...ALLOW, allow_circuits: false });
  await t.advance(4000, 50);
  refused(await ack, /circuits et pompes.*pas autorisées/);
  assert.equal(t.panel.sets().length, 0);
});

test('set points: a spa up to 40 °C (104 °F), a pool up to its ceiling, bounded after conversion', async () => {
  const t = await setup({ config: ALLOW });
  ok(await t.press('setpoint-B1202', 40));
  assert.equal(t.panel.objects.B1202.LOTMP, '104');
  refused(await t.press('setpoint-B1202', 40.5), /hors bornes : 4,44 à 40 °C/);
  ok(await t.press('setpoint-B1101', '28.5'));
  assert.equal(t.panel.objects.B1101.LOTMP, '83', '28.5 °C = 83.3 °F');
  refused(await t.press('setpoint-B1101', 36), /hors bornes : 4,44 à 35 °C/);
  for (const bad of ['', ' ', 'abc', null, true, '1e2']) {
    refused(await t.press('setpoint-B1101', bad), /Valeur invalide/);
  }
  const writes = t.panel.sets().map((r) => r.message.objectList[0].params.LOTMP);
  assert.deepEqual(writes, ['104', '83']);
  for (const w of writes) assert.ok(((Number(w) - 32) * 5) / 9 <= 40);
});

test('set points in °C: whole degrees, the configured pool ceiling', async () => {
  const t = await setup({ config: { ...ALLOW, max_pool_setpoint: 30 } });
  t.panel.system.MODE = 'METRIC';
  t.panel.objects.B1101.LOTMP = '27';
  ok(await t.press('setpoint-B1101', 29.6));
  assert.equal(t.panel.objects.B1101.LOTMP, '30');
  refused(await t.press('setpoint-B1101', 30.5), /hors bornes : 4 à 30 °C/);
  ok(await t.press('setpoint-B1202', 40));
  assert.equal(t.panel.objects.B1202.LOTMP, '40');
  refused(await t.press('setpoint-B1202', 41), /4 à 40 °C/);
});

test('the unit of the panel unknown: no set point written', async () => {
  const t = await setup({ config: ALLOW });
  t.panel.system.MODE = 'SOMETHING';
  refused(await t.press('setpoint-B1101', 28), /unité de température/);
  assert.equal(t.panel.sets().length, 0);
});

test('heat mode: a source from the list; an unknown value refused', async () => {
  const t = await setup({ config: ALLOW });
  ok(await t.press('heat-mode-B1101', 'solar-preferred'));
  assert.equal(t.panel.objects.B1101.MODE, '4');
  refused(await t.press('heat-mode-B1101', 'turbo'), /Valeur invalide/);
  refused(await t.press('heat-mode-B1101', '__proto__'), /Valeur invalide/);
});

test('confirmed only by the read back: not applied, other value, no read back', async () => {
  const t = await setup({ config: ALLOW });
  t.panel.ignoreSet = true;
  refused(await t.press('circuit-C0004', 'on'), /pas encore appliqué/);
  t.panel.ignoreSet = false;
  t.panel.dropSet = 'after';
  refused(await t.press('circuit-C0003', 'on'), /Envoyé, sans confirmation \(closed\)/);
  t.panel.dropSet = undefined;
  t.panel.refuseSet = '400';
  refused(await t.press('heat-mode-B1101', 'heater'), /refusé \(refused \(400\)\)/);
});

test('already so: success without writing; the same setting twice in one batch: the last wins', async () => {
  const t = await setup({ config: ALLOW });
  ok(await t.press('circuit-C0006', 'on'));
  assert.equal(t.panel.sets().length, 0);
  const a = t.fire('setpoint-B1101', 27);
  const b = t.fire('setpoint-B1101', 30);
  await t.advance(5000, 50);
  refused(await a, /plus récente/);
  ok(await b);
  assert.equal(t.panel.sets().length, 1);
  assert.equal(t.panel.objects.B1101.LOTMP, '86');
});

test('a scene on 5 settings, a slow panel (500-900 ms): all set, in one write', async () => {
  const t = await setup({ config: ALLOW });
  let n = 0;
  t.panel.latencyMs = () => 500 + ((n += 1) % 5) * 100;
  const acks = [
    t.fire('circuit-C0003', 'on'),
    t.fire('circuit-C0004', 'on'),
    t.fire('heat-mode-B1101', 'heater'),
    t.fire('setpoint-B1101', 30),
    t.fire('setpoint-B1202', 37),
  ];
  await t.advance(6000, 50);
  for (const ack of acks) ok(await ack);
  assert.equal(t.panel.sets().length, 1);
  assert.equal(lastSet(t.panel).length, 4, 'one entry per object');
  assert.equal(t.panel.objects.C0003.STATUS, 'ON');
  assert.equal(t.panel.objects.C0004.STATUS, 'ON');
  assert.equal(t.panel.objects.B1101.MODE, '2');
  assert.equal(t.panel.objects.B1101.LOTMP, '86');
  assert.equal(t.panel.objects.B1202.LOTMP, '99');
});

test('a panel that never gives the turn in time: nothing sent, answered by 4.3 s', async () => {
  const t = await setup({ config: ALLOW });
  t.panel.latencyMs = 3000;
  const start = t.clock.elapsed;
  const ack = t.fire('circuit-C0004', 'on');
  let at;
  ack.then(() => (at = t.clock.elapsed));
  await t.advance(8000, 50);
  refused(await ack, /Rien envoyé|rien envoyé/);
  assert.ok(at - start <= 4400, `${at - start} ms`);
  assert.equal(t.panel.sets().length, 0);
});

test('another panel at the address: nothing sent', async () => {
  const t = await setup({ config: ALLOW });
  t.panel.system.SNAME = 'Another one';
  refused(await t.press('circuit-C0004', 'on'), /Un autre panneau/);
  assert.equal(t.panel.sets().length, 0);
});

test('a read-only feature and an unknown feature take no command', async () => {
  const t = await setup({ config: ALLOW });
  refused(await t.press('water-temp-B1101', 30), /aucune commande/);
  refused(await t.press('pump-rpm-P0001', 1000), /aucune commande/);
  refused(await t.press('nope', 1), /aucune commande/);
  refused(await t.press('circuit-C0004', 'maybe'), /Valeur invalide/);
  assert.equal(t.panel.sets().length, 0);
  assert.equal(SECOND, 1000);
});
