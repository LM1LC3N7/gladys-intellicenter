// -----------------------------------------------------------------------------
// The answers of the panel -> plain values (pure). Every field is read by
// name from what JSON.parse gave, never merged into an object: a key such as
// `__proto__` in an answer is just never read. A value the panel does not
// have comes back as its own key name (`"PHVAL": "PHVAL"`): unknown, as an
// empty or non-numeric text. Numbers are strict ("", " ", "7,2" or "1e3" are
// not numbers).
//
// Temperatures: the panel speaks °F when its system `MODE` is "ENGLISH", °C
// when "METRIC" (pyintellicenter `uses_metric`); any other value: unknown, no
// temperature is published and no set point written. °F are converted
// exactly ((F − 32) × 5 / 9), rounded to the hundredth for display only; the
// bounds of a set point are checked on the whole degree written, after the
// conversion.
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import {
  BODY_SUBTYPES,
  LIGHT_SUBTYPES,
  LIMITS,
  OBJECT_KEYS,
  OBJNAM,
  SETPOINT,
} from '../constants.js';

const own = (object, key) =>
  object !== null && typeof object === 'object' && Object.hasOwn(object, key)
    ? object[key]
    : undefined;

/** A text value of the panel: a string that is not its own key (undefined otherwise). */
export function textOf(params, key) {
  const value = own(params, key);
  if (typeof value === 'string' && value !== key && value.length <= 200) {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

/** A strict number: "72", "-4", "7.4"; never "", " ", "7,4", "1e3", "Infinity". */
export function numberOf(text) {
  if (typeof text !== 'string' || !/^-?\d{1,7}(?:\.\d{1,6})?$/.test(text)) {
    return undefined;
  }
  return Number(text);
}

/** A whole number only ("72"; "72.5" is not one). */
export function integerOf(text) {
  const n = numberOf(text);
  return n !== undefined && Number.isInteger(n) ? n : undefined;
}

/** A name of the panel as shown: no control characters, trimmed, cut. */
export function cleanName(text) {
  if (typeof text !== 'string') return undefined;
  const clean = text
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return clean === '' ? undefined : clean.slice(0, LIMITS.maxName).trim();
}

/** The id of the panel: a hash of its system `SNAME` (the reference's unique id), 16 hex. */
export function panelIdOf(sname) {
  return createHash('sha256').update(`intellicenter:${sname}`).digest('hex').slice(0, 16);
}

export const PANEL_ID = /^[0-9a-f]{16}$/;

/** The `objectList` of an answer, bounded (undefined when it is not a list). */
function listOf(answer) {
  const list = own(answer, 'objectList');
  return Array.isArray(list) ? list.slice(0, LIMITS.maxObjects) : undefined;
}

/** The system object of a `GetParamList` with `condition: "OBJTYP=SYSTEM"`. */
export function parseSystem(answer) {
  const list = listOf(answer);
  const params = own(list?.[0], 'params');
  const sname = textOf(params, 'SNAME');
  if (!sname || sname.trim() === '') {
    return undefined;
  }
  const mode = textOf(params, 'MODE');
  return {
    id: panelIdOf(sname),
    name: cleanName(textOf(params, 'PROPNAME')),
    version: cleanName(textOf(params, 'VER')),
    unit: mode === 'ENGLISH' ? 'F' : mode === 'METRIC' ? 'C' : undefined,
  };
}

/**
 * The objects of a `GetParamList` answer: objnam -> { objnam, type, subtype,
 * name, values } where `values` holds the texts of the keys asked for only
 * (null prototype). An entry without a valid objnam is skipped.
 */
export function parseObjects(answer, keys = OBJECT_KEYS) {
  const list = listOf(answer);
  if (!list) {
    return undefined;
  }
  const objects = new Map();
  for (const entry of list) {
    const objnam = own(entry, 'objnam');
    if (typeof objnam !== 'string' || !OBJNAM.test(objnam) || objects.has(objnam)) {
      continue;
    }
    const params = own(entry, 'params');
    const values = Object.create(null);
    for (const key of keys) {
      const value = textOf(params, key);
      if (value !== undefined) values[key] = value;
    }
    objects.set(objnam, {
      objnam,
      type: values.OBJTYP,
      subtype: values.SUBTYP,
      name: cleanName(values.SNAME),
      values,
    });
  }
  return objects;
}

const round2 = (value) => Math.round(value * 100) / 100;

/** A temperature of the panel in °C (exact conversion from °F), else undefined. */
export function celsiusOf(text, unit) {
  const value = numberOf(text);
  if (value === undefined) return undefined;
  if (unit === 'C') return value;
  if (unit === 'F') return round2(((value - 32) * 5) / 9);
  return undefined;
}

/** What the panel shows for a body: kind, its circuit, its temperature... */
export const isLight = (o) => o.type === 'CIRCUIT' && LIGHT_SUBTYPES.has(o.subtype);
export const isBodyCircuit = (o) => o.type === 'CIRCUIT' && BODY_SUBTYPES.has(o.subtype);

/** The circuits shown: body circuits, lights, and the "featured" ones (FEATR ON). */
export const isShownCircuit = (o) =>
  o.type === 'CIRCUIT' && (isBodyCircuit(o) || isLight(o) || o.values.FEATR === 'ON');

/** The objects of the panel grouped by what Gladys shows, in objnam order, bounded per kind. */
export function groupObjects(objects) {
  const sorted = [...(objects?.values() ?? [])].sort((a, b) =>
    a.objnam < b.objnam ? -1 : a.objnam > b.objnam ? 1 : 0,
  );
  const take = (test) => sorted.filter(test).slice(0, LIMITS.maxPerKind);
  return {
    bodies: take((o) => o.type === 'BODY'),
    circuits: take(isShownCircuit),
    pumps: take((o) => o.type === 'PUMP'),
    sensors: take((o) => o.type === 'SENSE' && ['AIR', 'SOLAR', 'POOL'].includes(o.subtype)),
    chems: take((o) => o.type === 'CHEM' && ['ICHEM', 'ICHLOR'].includes(o.subtype)),
  };
}

/**
 * The body a circuit drives (its `BODY`), else the body of the same sub-type
 * when there is exactly one (a POOL circuit, the POOL body). Undefined: not known.
 */
export function bodyOfCircuit(circuit, objects) {
  const ref = circuit?.values?.BODY;
  if (ref && OBJNAM.test(ref) && objects?.get(ref)?.type === 'BODY') {
    return ref;
  }
  if (!isBodyCircuit(circuit ?? {})) return undefined;
  const same = [...(objects?.values() ?? [])].filter(
    (o) => o.type === 'BODY' && o.subtype === circuit.subtype,
  );
  return same.length === 1 ? same[0].objnam : undefined;
}

/** The ceiling of the heating set point of a body, °C: a spa 40, a pool the configuration's. */
export function ceilingOf(body, poolCeiling) {
  const pool = Math.min(SETPOINT.maxC, poolCeiling);
  if (body?.subtype === 'SPA') return SETPOINT.spaMaxC;
  if (body?.subtype === 'POOL') return pool;
  // A body of another kind: the lower of both.
  return Math.min(SETPOINT.spaMaxC, pool);
}

/**
 * The whole degree to write for a set point asked in °C, in the unit of the
 * panel: `{ value }` (a string), or `{ low, high }` (°C) when out of bounds.
 * The bounds are those of the written degree after conversion: low rounded
 * up, high rounded down; a final check refuses anything above the ceiling.
 */
export function setpointToWrite(celsius, unit, ceilingC) {
  const ceiling = Math.min(ceilingC, SETPOINT.maxC, SETPOINT.spaMaxC);
  if (!Number.isFinite(celsius)) {
    return undefined;
  }
  if (unit === 'C') {
    const low = SETPOINT.minC;
    const high = Math.floor(ceiling);
    if (celsius < low - 0.5 || celsius > ceiling) {
      return { low, high };
    }
    const value = Math.min(high, Math.max(low, Math.round(celsius)));
    // The written degree is never above the ceiling (final check).
    if (value > ceiling || value > SETPOINT.spaMaxC) {
      return { low, high };
    }
    return { value: String(value), celsius: value };
  }
  if (unit === 'F') {
    // 40 °F (4.44 °C) .. the ceiling in °F rounded down (40 °C = 104 °F).
    const lowF = SETPOINT.minF;
    const highF = Math.min(SETPOINT.maxF, Math.floor((ceiling * 9) / 5 + 32));
    const lowC = round2(((lowF - 32) * 5) / 9);
    const highC = round2(((highF - 32) * 5) / 9);
    if (celsius < SETPOINT.minC - 0.5 || celsius > ceiling) {
      return { low: lowC, high: highC };
    }
    const value = Math.min(highF, Math.max(lowF, Math.round((celsius * 9) / 5 + 32)));
    const back = ((value - 32) * 5) / 9;
    // The written degree, converted back, is never above the ceiling (final check).
    if (back > ceiling + 1e-9 || back > SETPOINT.spaMaxC + 1e-9) {
      return { low: lowC, high: highC };
    }
    return { value: String(value), celsius: round2(back) };
  }
  return undefined;
}
