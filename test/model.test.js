// -----------------------------------------------------------------------------
// The answers of the panel read strictly: numbers, unknown keys, units, the
// bounds of a set point on the degree written (°F converted exactly), no
// prototype pollution.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  bodyOfCircuit,
  ceilingOf,
  celsiusOf,
  cleanName,
  groupObjects,
  integerOf,
  numberOf,
  panelIdOf,
  parseObjects,
  parseSystem,
  setpointToWrite,
} from '../src/ic/model.js';

test('numbers are strict: empty, spaces, commas, exponents, key names are not numbers', () => {
  assert.equal(numberOf('72'), 72);
  assert.equal(numberOf('-4'), -4);
  assert.equal(numberOf('7.4'), 7.4);
  for (const bad of ['', ' ', '7,4', '1e3', 'Infinity', 'NaN', 'TEMP', ' 72', '0x10', null, 72]) {
    assert.equal(numberOf(bad), undefined, String(bad));
  }
  assert.equal(integerOf('72.5'), undefined);
  assert.equal(integerOf('72'), 72);
});

test('the system: id from SNAME, unit from MODE, nothing without SNAME', () => {
  const answer = (params) => ({ objectList: [{ objnam: '_5451', params }] });
  const s = parseSystem(answer({ PROPNAME: 'Home', VER: '1.064', MODE: 'ENGLISH', SNAME: 'abc' }));
  assert.equal(s.id, panelIdOf('abc'));
  assert.match(s.id, /^[0-9a-f]{16}$/);
  assert.equal(s.unit, 'F');
  assert.equal(parseSystem(answer({ MODE: 'METRIC', SNAME: 'abc' })).unit, 'C');
  assert.equal(parseSystem(answer({ MODE: 'MODE', SNAME: 'abc' })).unit, undefined);
  assert.equal(parseSystem(answer({ MODE: 'METRIC', SNAME: 'SNAME' })), undefined);
  assert.equal(parseSystem(answer({ MODE: 'METRIC' })), undefined);
  assert.equal(parseSystem({}), undefined);
  assert.equal(parseSystem({ objectList: 'x' }), undefined);
});

test('objects: a key echoed is unknown, bad objnams skipped, no prototype pollution', () => {
  const answer = JSON.parse(
    '{"objectList":[' +
      '{"objnam":"B1101","params":{"OBJTYP":"BODY","SUBTYP":"POOL","TEMP":"TEMP","LOTMP":"84","__proto__":{"polluted":1}}},' +
      '{"objnam":"../x","params":{"OBJTYP":"BODY"}},' +
      '{"objnam":"C0001","params":{"OBJTYP":"CIRCUIT","STATUS":"ON","constructor":"x"}},' +
      '{"objnam":"B1101","params":{"OBJTYP":"PUMP"}},' +
      '{"params":{}}, 42, null]}',
  );
  const objects = parseObjects(answer);
  assert.deepEqual([...objects.keys()], ['B1101', 'C0001']);
  const body = objects.get('B1101');
  assert.equal(body.type, 'BODY', 'the first entry of a name wins');
  assert.equal(body.values.TEMP, undefined);
  assert.equal(body.values.LOTMP, '84');
  assert.equal({}.polluted, undefined);
  assert.equal(Object.getPrototypeOf(body.values), null);
  assert.equal(parseObjects({ objectList: {} }), undefined);
});

test('names: control characters removed, cut to 40 characters', () => {
  assert.equal(cleanName('Pool\r\nLight\u0000'), 'Pool Light');
  assert.equal(cleanName('   '), undefined);
  assert.equal(cleanName('x'.repeat(100)).length, 40);
});

test('temperatures: °F converted exactly, an unknown unit gives nothing', () => {
  assert.equal(celsiusOf('104', 'F'), 40);
  assert.equal(celsiusOf('84', 'F'), 28.89);
  assert.equal(celsiusOf('32', 'F'), 0);
  assert.equal(celsiusOf('28', 'C'), 28);
  assert.equal(celsiusOf('84', undefined), undefined);
  assert.equal(celsiusOf('', 'F'), undefined);
});

test('a spa never above 40 °C on the degree written, °C and °F', () => {
  const spa = ceilingOf({ subtype: 'SPA' }, 35);
  assert.equal(spa, 40);
  assert.deepEqual(setpointToWrite(40, 'F', spa), { value: '104', celsius: 40 });
  assert.deepEqual(setpointToWrite(40, 'C', spa), { value: '40', celsius: 40 });
  assert.equal(setpointToWrite(40.01, 'F', spa).value, undefined);
  assert.equal(setpointToWrite(40.01, 'C', spa).value, undefined);
  assert.equal(setpointToWrite(41, 'F', spa).value, undefined);
  // 39.9 °C = 103.82 °F: rounded to 104 °F = 40 °C, never above.
  assert.equal(setpointToWrite(39.9, 'F', spa).value, '104');
  // A pool ceiling of 35 °C: 95 °F; 34.9 °C -> 94.82 -> 95 = 35 °C.
  const pool = ceilingOf({ subtype: 'POOL' }, 35);
  assert.equal(setpointToWrite(34.9, 'F', pool).value, '95');
  assert.equal(setpointToWrite(35.5, 'F', pool).value, undefined);
  // A ceiling of 33 °C: 91.4 °F rounded down to 91 (32.78 °C).
  assert.deepEqual(setpointToWrite(33, 'F', ceilingOf({ subtype: 'POOL' }, 33)), {
    value: '91',
    celsius: 32.78,
  });
  // Low bound: 4 °C rounded up to 40 °F; below refused.
  assert.equal(setpointToWrite(4, 'F', pool).value, '40');
  assert.equal(setpointToWrite(3, 'F', pool).value, undefined);
  assert.equal(setpointToWrite(3.4, 'C', pool).value, undefined);
  assert.equal(setpointToWrite(Number.NaN, 'C', pool), undefined);
  assert.equal(setpointToWrite(30, undefined, pool), undefined);
  // A body of another kind: the lower ceiling of both; a configured ceiling above 40: 40.
  assert.equal(ceilingOf({ subtype: 'OTHER' }, 38), 38);
  assert.equal(ceilingOf({ subtype: 'POOL' }, 50), 40);
  assert.equal(setpointToWrite(45, 'C', 99).value, undefined);
});

test('groups: featured circuits, lights and body circuits only; the body of a circuit', () => {
  const objects = parseObjects({
    objectList: [
      { objnam: 'B1101', params: { OBJTYP: 'BODY', SUBTYP: 'POOL' } },
      { objnam: 'C0006', params: { OBJTYP: 'CIRCUIT', SUBTYP: 'POOL', STATUS: 'ON' } },
      { objnam: 'C0003', params: { OBJTYP: 'CIRCUIT', SUBTYP: 'INTELLI', FEATR: 'OFF' } },
      { objnam: 'C0005', params: { OBJTYP: 'CIRCUIT', SUBTYP: 'GENERIC', FEATR: 'OFF' } },
      { objnam: 'C0007', params: { OBJTYP: 'CIRCUIT', SUBTYP: 'GENERIC', FEATR: 'ON' } },
    ],
  });
  const g = groupObjects(objects);
  assert.deepEqual(
    g.circuits.map((o) => o.objnam),
    ['C0003', 'C0006', 'C0007'],
  );
  assert.equal(bodyOfCircuit(objects.get('C0006'), objects), 'B1101', 'the only POOL body');
  assert.equal(bodyOfCircuit(objects.get('C0007'), objects), undefined);
});
