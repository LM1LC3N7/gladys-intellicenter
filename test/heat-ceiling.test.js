// -----------------------------------------------------------------------------
// Heating started or enabled heats to the set point the body already holds
// (left above the ceiling by the Pentair app, say): every path that starts it
// (a heat source, a body circuit, a circuit group) checks that set point on
// the fresh read against the body's ceiling (a pool the configuration's, a
// spa 40 °C) and refuses when it is above or unreadable. Turning off never.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { heldSetpoint } from '../src/ic/model.js';
import { HOST, fakePanel, initialObjects } from './fixtures/fakePanel.js';
import { ALLOW, MINUTE, ok, refused, setup } from './helpers.js';
import { testClock } from './kit/clock.mjs';

const ABOVE =
  /Chauffage de Pool non lancé : la consigne qu'il garde \(36,67 °C\) dépasse son plafond \(35 °C\)/;
const UNREADABLE = /non lancé : la consigne qu'il garde est illisible/;

const GROUP = {
  OBJTYP: 'CIRCUIT',
  SUBTYP: 'CIRCGRP',
  SNAME: 'Spa Mode',
  STATUS: 'OFF',
  FEATR: 'ON',
};

/** A panel changed before the first read (the objects every read asks for). */
async function setupWith(change, config = ALLOW) {
  const clock = testClock();
  const panel = fakePanel({ timers: clock.timers });
  change(panel);
  return setup({ config, clock, panel });
}

test('heldSetpoint: on the whole degree, the ceiling in °F rounded down; unreadable', () => {
  const body = (LOTMP) => ({ objnam: 'B1', type: 'BODY', values: { LOTMP } });
  assert.deepEqual(heldSetpoint(body('95'), 'F', 35), { state: 'ok' });
  assert.deepEqual(heldSetpoint(body('96'), 'F', 35), {
    state: 'above',
    celsius: 35.56,
    ceiling: 35,
  });
  assert.deepEqual(heldSetpoint(body('35'), 'C', 35), { state: 'ok' });
  assert.equal(heldSetpoint(body('36'), 'C', 35).state, 'above');
  assert.equal(heldSetpoint(body('35.5'), 'C', 35).state, 'above');
  // A ceiling of 35.5 °C is 95.9 °F: 95 °F at most.
  assert.equal(heldSetpoint(body('95'), 'F', 35.5).state, 'ok');
  assert.equal(heldSetpoint(body('96'), 'F', 35.5).state, 'above');
  // 40 °C at most, whatever the ceiling asked.
  assert.equal(heldSetpoint(body('104'), 'F', 45).state, 'ok');
  assert.equal(heldSetpoint(body('105'), 'F', 45).state, 'above');
  assert.equal(heldSetpoint(body('41'), 'C', 45).state, 'above');
  for (const LOTMP of [undefined, '', 'LOTMP', '9x']) {
    assert.deepEqual(heldSetpoint(body(LOTMP), 'F', 35), { state: 'unreadable' });
  }
  assert.deepEqual(heldSetpoint(body('80'), undefined, 35), { state: 'unreadable' });
  assert.deepEqual(heldSetpoint(undefined, 'F', 35), { state: 'unreadable' });
});

test('heat source: refused while the pool holds a set point above its ceiling; the status says why', async () => {
  const t = await setupWith((p) => (p.objects.B1101.LOTMP = '98'));
  refused(await t.press('heat-mode-B1101', 'heater'), ABOVE);
  assert.equal(t.panel.sets().length, 0);
  assert.equal(t.panel.objects.B1101.MODE, '1');
  assert.match(t.status().text, ABOVE);
  assert.match(t.status().en, /Heating of Pool not started: .*above its ceiling \(35 °C\)/);
  // 96 °F (35.56 °C) is still above; 95 °F (35 °C) is the ceiling.
  t.panel.objects.B1101.LOTMP = '96';
  refused(await t.press('heat-mode-B1101', 'heater'), /35,56 °C\) dépasse son plafond/);
  t.panel.objects.B1101.LOTMP = '95';
  ok(await t.press('heat-mode-B1101', 'heater'));
  assert.equal(t.panel.objects.B1101.MODE, '2');
  assert.doesNotMatch(t.status().text, /non lancé/);
});

test('heat source: the ceiling of the configuration; a spa is held to 40 °C only', async () => {
  const t = await setupWith(
    (p) => {
      p.objects.B1101.LOTMP = '86'; // 30 °C
      p.objects.B1202.MODE = '1';
      p.objects.B1202.LOTMP = '104'; // 40 °C
    },
    { ...ALLOW, max_pool_setpoint: 29 },
  );
  refused(await t.press('heat-mode-B1101', 'heater'), /\(30 °C\) dépasse son plafond \(29 °C\)/);
  ok(await t.press('heat-mode-B1202', 'heater'));
  t.panel.objects.B1202.MODE = '1';
  t.panel.objects.B1202.LOTMP = '105';
  refused(
    await t.press('heat-mode-B1202', 'heater'),
    /Chauffage de Spa non lancé .*\(40,56 °C\) dépasse son plafond \(40 °C\)/,
  );
  assert.equal(t.panel.objects.B1202.MODE, '1');
});

test('heat source: a panel in °C, compared on the degree', async () => {
  const clock = testClock();
  const panel = fakePanel({ timers: clock.timers, mode: 'METRIC' });
  panel.objects.B1101.LOTMP = '36';
  const t = await setup({ config: ALLOW, clock, panel });
  refused(await t.press('heat-mode-B1101', 'heater'), /\(36 °C\) dépasse son plafond \(35 °C\)/);
  t.panel.objects.B1101.LOTMP = '35';
  ok(await t.press('heat-mode-B1101', 'heater'));
});

test('heat source: refused when the set point or the unit cannot be read', async () => {
  const t = await setupWith((p) => delete p.objects.B1101.LOTMP);
  refused(await t.press('heat-mode-B1101', 'heater'), UNREADABLE);
  t.panel.objects.B1101.LOTMP = 'LOTMP';
  refused(await t.press('heat-mode-B1101', 'heater'), UNREADABLE);
  assert.match(t.status().text, UNREADABLE);
  t.panel.objects.B1101.LOTMP = '84';
  t.panel.system.MODE = 'SOMETHING';
  refused(await t.press('heat-mode-B1101', 'heater'), UNREADABLE);
  assert.equal(t.panel.sets().length, 0);
});

test('heat source already selected: still refused (not "already so") above the ceiling', async () => {
  const t = await setupWith((p) => {
    p.objects.B1202.LOTMP = '106';
  });
  // The spa already heats with its heater (MODE 2).
  refused(
    await t.press('heat-mode-B1202', 'heater'),
    /Spa non lancé .*dépasse son plafond \(40 °C\)/,
  );
});

test('the option is checked first: "heating" not allowed says so, not the set point', async () => {
  const t = await setupWith((p) => (p.objects.B1101.LOTMP = '98'), {
    host: HOST,
    allow_circuits: true,
  });
  refused(await t.press('heat-mode-B1101', 'heater'), /chauffage.*pas autorisées/);
  t.panel.objects.C0006.STATUS = 'OFF';
  t.panel.objects.B1101.MODE = '2';
  refused(await t.press('circuit-C0006', 'on'), /peut lancer le chauffage/);
  assert.doesNotMatch(t.status().text, /non lancé/);
});

test('turning off is never blocked by the held set point', async () => {
  const t = await setupWith((p) => {
    p.objects.B1202.LOTMP = '110';
    p.objects.C0001.STATUS = 'ON';
  });
  ok(await t.press('heat-mode-B1202', 'off'));
  assert.equal(t.panel.objects.B1202.MODE, '1');
  ok(await t.press('circuit-C0001', 'off'));
  assert.equal(t.panel.objects.C0001.STATUS, 'OFF');
});

test('body circuit: its pump starts the heating of its body: checked; heat mode off: not', async () => {
  const t = await setupWith((p) => {
    p.objects.B1202.LOTMP = '106';
    p.objects.B1101.LOTMP = '98';
    p.objects.B1101.MODE = '2';
    p.objects.C0006.STATUS = 'OFF';
  });
  refused(await t.press('circuit-C0001', 'on'), /Spa non lancé .*dépasse son plafond/);
  refused(await t.press('circuit-C0006', 'on'), ABOVE);
  assert.equal(t.panel.sets().length, 0);
  // Heating still reported (HTMODE) with the mode Off: it may heat, checked.
  t.panel.objects.B1101.MODE = '1';
  t.panel.objects.B1101.HTMODE = '1';
  refused(await t.press('circuit-C0006', 'on'), ABOVE);
  // Its heat mode seen Off, not heating: the pump only, allowed.
  t.panel.objects.B1101.HTMODE = '0';
  ok(await t.press('circuit-C0006', 'on'));
  assert.equal(t.panel.objects.C0006.STATUS, 'ON');
  // Within the ceiling: allowed while heating.
  t.panel.objects.B1202.LOTMP = '102';
  ok(await t.press('circuit-C0001', 'on'));
  assert.equal(t.panel.objects.C0001.STATUS, 'ON');
});

test('body circuit whose body is not known: its set point cannot be read, refused', async () => {
  const t = await setupWith((p) => {
    // Two spas and no BODY on the circuit: which one it drives is unknown.
    delete p.objects.C0001.BODY;
    p.objects.B1303 = { ...p.objects.B1202, SNAME: 'Spa 2', LOTMP: '90' };
  });
  refused(
    await t.press('circuit-C0001', 'on'),
    /Chauffage de Spa non lancé : la consigne .*illisible/,
  );
  assert.equal(t.panel.sets().length, 0);
});

test('circuit group: every body that may heat is checked; one above refuses the group', async () => {
  const t = await setupWith((p) => {
    p.objects.GRP01 = { ...GROUP };
    p.objects.B1202.LOTMP = '106';
    p.objects.B1101.LOTMP = '98';
  });
  // The spa heats (MODE 2) above 40 °C; the pool is off (MODE 1, HTMODE 0).
  refused(await t.press('circuit-GRP01', 'on'), /Spa non lancé .*dépasse son plafond \(40 °C\)/);
  // A body that does not heat is not checked: the pool above its ceiling but off.
  t.panel.objects.B1202.LOTMP = '100';
  ok(await t.press('circuit-GRP01', 'on'));
  t.panel.objects.GRP01.STATUS = 'OFF';
  // The pool heats too, above its ceiling.
  t.panel.objects.B1101.MODE = '2';
  t.panel.objects.B1101.LOTMP = '98';
  refused(await t.press('circuit-GRP01', 'on'), ABOVE);
  assert.equal(t.panel.sets().length, 1, 'only the first group on');
  // Both heat, the pool (read first) within its ceiling, the spa above: refused for the spa.
  t.panel.objects.B1101.LOTMP = '90';
  t.panel.objects.B1202.LOTMP = '106';
  refused(await t.press('circuit-GRP01', 'on'), /Spa non lancé .*dépasse son plafond \(40 °C\)/);
  assert.equal(t.panel.sets().length, 1);
  t.panel.objects.B1202.LOTMP = '100';
  ok(await t.press('circuit-GRP01', 'on'));
  assert.equal(t.panel.objects.GRP01.STATUS, 'ON');
});

test('circuit group with no body read: the set points cannot be read, refused', async () => {
  const t = await setupWith((p) => {
    p.objects.GRP01 = { ...GROUP };
    delete p.objects.B1101;
    delete p.objects.B1202;
  });
  refused(await t.press('circuit-GRP01', 'on'), /Spa Mode non lancé : la consigne .*illisible/);
  assert.equal(t.panel.sets().length, 0);
  // Still no body read: still said.
  await t.advance(2 * MINUTE, 100);
  assert.match(t.status().text, /Spa Mode non lancé/);
  // A body read, within its ceiling: cleared by that read.
  t.panel.objects.B1202 = { ...initialObjects().B1202 };
  // The pool does not heat (MODE 1): its set point above the ceiling is not checked.
  t.panel.objects.B1101 = { ...initialObjects().B1101, LOTMP: '98' };
  await t.advance(2 * MINUTE, 100);
  assert.doesNotMatch(t.status().text, /non lancé/);
});

test('the status note goes once a read shows the set point within the ceiling, or after 15 min', async () => {
  const t = await setupWith((p) => (p.objects.B1101.LOTMP = '98'));
  refused(await t.press('heat-mode-B1101', 'heater'), ABOVE);
  assert.match(t.status().text, ABOVE);
  // Still above at the next reads: still said.
  await t.advance(2 * MINUTE, 100);
  assert.match(t.status().text, ABOVE);
  // Lowered in the Pentair app: the next read clears it.
  t.panel.objects.B1101.LOTMP = '90';
  await t.advance(2 * MINUTE, 100);
  assert.doesNotMatch(t.status().text, /non lancé/);

  // Never lowered: said 15 minutes, then gone.
  t.panel.objects.B1101.LOTMP = '98';
  refused(await t.press('heat-mode-B1101', 'heater'), ABOVE);
  await t.advance(14 * MINUTE, 1000);
  assert.match(t.status().text, ABOVE);
  await t.advance(2 * MINUTE, 1000);
  assert.doesNotMatch(t.status().text, /non lancé/);
});

test('a refusal on a body circuit or a group is cleared by the next read once the body is within its ceiling', async () => {
  const SPA = /Chauffage de Spa non lancé/;
  const t = await setupWith((p) => {
    p.objects.B1202.LOTMP = '105';
    p.objects.GRP01 = { ...GROUP };
  });
  refused(await t.press('circuit-C0001', 'on'), SPA);
  refused(await t.press('circuit-GRP01', 'on'), SPA);
  assert.match(t.status().text, SPA);
  t.panel.objects.B1202.LOTMP = '100';
  await t.advance(2 * MINUTE, 100);
  assert.doesNotMatch(t.status().text, /non lancé/);
  ok(await t.press('circuit-C0001', 'on'));

  // Refused again, then accepted before any read: the success clears it at once.
  t.panel.objects.C0001.STATUS = 'OFF';
  t.panel.objects.B1202.LOTMP = '105';
  refused(await t.press('circuit-C0001', 'on'), SPA);
  t.panel.objects.B1202.LOTMP = '100';
  const ack = t.fire('circuit-C0001', 'on');
  await t.advance(1500, 50);
  ok(await ack);
  assert.doesNotMatch(t.status().text, /non lancé/);
});

test('a refusal with no body known is cleared once a read knows the body within its ceiling', async () => {
  const t = await setupWith((p) => {
    delete p.objects.C0001.BODY;
    p.objects.B1303 = { ...p.objects.B1202, SNAME: 'Spa 2', LOTMP: '90' };
  });
  refused(await t.press('circuit-C0001', 'on'), /illisible/);
  await t.advance(2 * MINUTE, 100);
  assert.match(t.status().text, /illisible/, 'still unknown: still said');
  t.panel.objects.C0001.BODY = 'B1202';
  await t.advance(2 * MINUTE, 100);
  assert.doesNotMatch(t.status().text, /non lancé/);
});

test('the status says 3 heating refusals at most, the latest', async () => {
  const t = await setupWith((p) => {
    for (const [objnam, name] of [
      ['B1101', 'Pool'],
      ['B1303', 'Pool B'],
      ['B1404', 'Pool C'],
      ['B1505', 'Pool D'],
    ]) {
      p.objects[objnam] = { ...p.objects.B1101, SNAME: name, LOTMP: '98' };
    }
  });
  for (const b of ['B1101', 'B1303', 'B1404', 'B1505']) {
    refused(await t.press(`heat-mode-${b}`, 'heater'), /dépasse son plafond/);
  }
  const text = t.status().text;
  assert.equal(text.match(/non lancé/g).length, 3);
  assert.doesNotMatch(text, /Chauffage de Pool non lancé/);
  assert.match(text, /Chauffage de Pool D non lancé/);
});

test('a scene lowering the set point and choosing a source: the source refused, a second click passes', async () => {
  const t = await setupWith((p) => (p.objects.B1101.LOTMP = '98'));
  const setpoint = t.fire('setpoint-B1101', 28);
  const source = t.fire('heat-mode-B1101', 'heater');
  await t.advance(5000, 50);
  ok(await setpoint);
  // Decided on the read before the write, which still shows 98 °F.
  refused(await source, ABOVE);
  assert.equal(t.panel.objects.B1101.LOTMP, '82');
  assert.equal(t.panel.objects.B1101.MODE, '1');
  ok(await t.press('heat-mode-B1101', 'heater'));
  assert.equal(t.panel.objects.B1101.MODE, '2');
});
