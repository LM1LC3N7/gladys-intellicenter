// -----------------------------------------------------------------------------
// The device of the panel: ids parsed strictly, the units and options the
// core accepts (its own normalizeSupportedOptions when the clone is there,
// else the same rules), no switch, the states of one read (never a text nor
// an unavailable 0 as a measure), features of the created device kept.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import {
  COMMAND_KINDS,
  buildDevice,
  deviceStates,
  parseDeviceId,
  parseFeatureId,
} from '../src/devices.js';
import { parseObjects } from '../src/ic/model.js';
import { initialObjects } from './fixtures/fakePanel.js';

const CORE = '/home/claude/code/Gladys/server/utils';
const require = createRequire(import.meta.url);
const core = existsSync(`${CORE}/constants.js`) ? require(`${CORE}/constants.js`) : undefined;
let normalizeSupportedOptions;
try {
  normalizeSupportedOptions = require(
    `${CORE}/normalizeSupportedOptions.js`,
  ).normalizeSupportedOptions;
} catch {
  normalizeSupportedOptions = undefined;
}

const gladys = {
  externalIds: (type, id) => ({
    device: `ext:test:${type}:${id}`,
    feature: (key) => `ext:test:${type}:${id}:${key}`,
  }),
};
const ID = '0123456789abcdef';
const ids = gladys.externalIds('intellicenter', ID);
const objectsOf = (raw) =>
  parseObjects({ objectList: Object.entries(raw).map(([objnam, params]) => ({ objnam, params })) });
const panel = (raw = initialObjects(), unit = 'F') => ({
  id: ID,
  name: 'Home',
  unit,
  objects: objectsOf(raw),
});
const devices = ['en', 'fr'].map((language) => buildDevice(gladys, panel(), { language }));
const byRole = (states) =>
  Object.fromEntries(states.map((s) => [s.device_feature_external_id.split(':').at(-1), s]));

test('ids: the panel id, the kind and the objnam; parsed back strictly', () => {
  assert.equal(devices[0].external_id, `ext:test:intellicenter:${ID}`);
  assert.deepEqual(parseFeatureId(`ext:test:intellicenter:${ID}:water-temp-B1101`), {
    id: ID,
    role: 'water-temp-B1101',
    kind: 'water-temp',
    objnam: 'B1101',
  });
  assert.equal(parseFeatureId(`ext:test:intellicenter:${ID}:nope-B1101`), undefined);
  assert.equal(parseFeatureId(`ext:test:intellicenter:${ID}:circuit-../x`), undefined);
  assert.equal(parseFeatureId(`ext:test:intellicenter:XYZ:circuit-C0001`), undefined);
  assert.equal(parseFeatureId(42), undefined);
  assert.equal(parseDeviceId(`ext:test:intellicenter:${ID}`), ID);
  assert.equal(parseDeviceId(`ext:test:intellicenter:${ID}:status`), undefined);
});

test('no switch, no writable binary; the writable features are the commands', () => {
  for (const f of devices[0].features) {
    if (f.type === 'binary') assert.equal(f.read_only, true, f.name);
    assert.notEqual(f.category, 'switch', f.name);
    const kind = parseFeatureId(f.external_id).kind;
    assert.equal(f.read_only, !COMMAND_KINDS.includes(kind), f.name);
  }
  // The hidden circuit (not featured) and the heater have no feature.
  const roles = devices[0].features.map((f) => f.external_id.split(':').at(-1));
  assert.ok(!roles.some((r) => r.endsWith('C0005') || r.endsWith('H0001')));
});

const PAIRS = [
  ['temperature-sensor', 'celsius'],
  ['thermostat', 'celsius'],
  ['energy-sensor', 'watt'],
  ['ph-sensor', 'ph'],
  ['orp-sensor', 'millivolt'],
];

test('units: only the frozen pairs (checked against the core when its clone is there)', () => {
  for (const f of devices[0].features) {
    if (f.unit === undefined) continue;
    assert.ok(
      PAIRS.some(([c, u]) => c === f.category && u === f.unit),
      `${f.name}: ${f.category} ${f.unit}`,
    );
  }
  if (core) {
    for (const [c, u] of PAIRS) {
      assert.ok(core.DEVICE_FEATURE_UNITS_BY_CATEGORY[c]?.includes(u), `${c} ${u}`);
    }
    for (const f of devices[0].features) {
      assert.ok(Object.values(core.DEVICE_FEATURE_CATEGORIES).includes(f.category), f.category);
    }
  }
});

test('supported options: the rules of the core (label, value, unique, no other key)', () => {
  for (const d of devices) {
    for (const f of d.features.filter((x) => x.supported_options)) {
      const values = new Set();
      const labels = new Set();
      for (const o of f.supported_options) {
        assert.deepEqual(Object.keys(o).sort(), ['label', 'value']);
        assert.equal(typeof o.label, 'string');
        assert.ok(o.label.length > 0 && o.label === o.label.trim(), o.label);
        assert.ok(
          Number.isInteger(o.value) || (typeof o.value === 'string' && o.value.trim() !== ''),
        );
        assert.ok(!values.has(String(o.value)), 'unique value');
        assert.ok(!labels.has(o.label), 'unique label');
        values.add(String(o.value));
        labels.add(o.label);
      }
      if (normalizeSupportedOptions) {
        const allowStringValues = f.category === 'text' && f.type === 'select';
        assert.doesNotThrow(() =>
          normalizeSupportedOptions(f.supported_options, { allowStringValues }),
        );
      }
    }
  }
});

test('states: °F converted, unavailable values and texts never published as measures', () => {
  const raw = initialObjects();
  raw.CHEM1.PHVAL = '0';
  raw.CHEM1.ORPVAL = 'ORPVAL';
  raw.CHL01.SALT = '';
  raw.B1202.TEMP = '80';
  raw.P0001.RPM = 'abc';
  const s = byRole(deviceStates(ids, panel(raw), { online: true, language: 'fr' }));
  assert.equal(s['water-temp-B1101'].state, 27.78);
  assert.equal(s['water-temp-B1202'], undefined, 'the spa is off: its water temperature is old');
  assert.equal(s['setpoint-B1202'].state, 37.78);
  assert.equal(s['heat-mode-B1202'].text, 'heater');
  assert.equal(s['circuit-C0006'].text, 'on');
  assert.equal(s['ph-CHEM1'], undefined);
  assert.equal(s['orp-CHEM1'], undefined);
  assert.equal(s['salt-CHL01'], undefined);
  assert.equal(s['pump-rpm-P0001'], undefined);
  assert.equal(s['pump-running-P0001'].state, 1);
  assert.equal(s.status.text, 'Connecté');
  const metric = byRole(
    deviceStates(ids, panel(initialObjects(), 'C'), { online: true, language: 'en' }),
  );
  assert.equal(metric['setpoint-B1101'], undefined, '84 °C is out of range: not published');
  const unknown = byRole(
    deviceStates(ids, panel(initialObjects(), null), { online: true, language: 'en' }),
  );
  assert.equal(unknown['water-temp-B1101'], undefined);
  assert.equal(unknown['sensor-temp-S0001'], undefined);
  const offline = deviceStates(ids, panel(), { online: false, language: 'en' });
  assert.deepEqual(
    offline.map((x) => x.text),
    ['Panel unreachable'],
  );
});

test('a republished device keeps the features of the created one', () => {
  const raw = initialObjects();
  delete raw.C0004;
  const created = devices[0];
  const again = buildDevice(gladys, panel(raw), { language: 'en', created });
  const ext = (d) => d.features.map((f) => f.external_id).sort();
  assert.deepEqual(ext(again), ext(created));
  const kept = again.features.find((f) => f.external_id.endsWith('circuit-C0004'));
  assert.equal(kept.name, 'Cleaner - On / off');
  assert.ok(kept.supported_options.length === 2);
});
