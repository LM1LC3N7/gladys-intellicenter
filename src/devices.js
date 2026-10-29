// -----------------------------------------------------------------------------
// The panel -> one Gladys device and its states (pure).
//
// `ext:<selector>:intellicenter:<id>`: one device per panel, keyed by a hash of
// its system `SNAME` (src/ic/model.js), never by its IP address. A feature role
// is `<kind>-<objnam>` (`circuit-C0006`, `setpoint-B1101`): the kinds and the
// object names of the panel are published forever, never renamed. A device
// republished keeps every feature the created device has (`created`), even an
// object the panel no longer shows.
//
// No switch, no writable binary: a "turn everything off" (Google Home, Alexa,
// HomeKit, MCP, `switch.*` scenes) must never reach a pump, a heater or a
// circuit. A circuit is a `text/select` (on, off), the heat mode of a body a
// `text/select` (off and the heat sources), its heating set point a
// `thermostat/target-temperature` in °C. "Off" always works; the rest refuses
// unless the configuration allows it (src/app.js).
//
// Categories and units are those the core lists
// (DEVICE_FEATURE_UNITS_BY_CATEGORY): °C, pH, mV, W. The speed of a pump and
// the salt have no category: `unknown`, the unit in the name.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import {
  CIRCUIT_VALUES,
  HEAT_MODES,
  KINDS,
  OBJNAM,
  PUMP_OFF,
  PUMP_ON,
  SETPOINT,
  STATUS_ROLE,
} from './constants.js';
import {
  CIRCUIT_LABELS,
  FEATURE_NAMES,
  HEAT_MODE_LABELS,
  OBJECT_NAMES,
  STATE_TEXTS,
  word,
} from './i18n.js';
import { PANEL_ID, celsiusOf, groupObjects, integerOf, numberOf } from './ic/model.js';

const sensor = (definition) => ({
  read_only: true,
  has_feedback: false,
  keep_history: true,
  ...definition,
});
const select = {
  category: C.TEXT,
  type: T.TEXT.SELECT,
  min: 0,
  max: 0,
  read_only: false,
  has_feedback: true,
  keep_history: false,
};

/** The features of each kind (the select options are added in buildDevice). */
export const DEFINITIONS = {
  [STATUS_ROLE]: sensor({
    category: C.TEXT,
    type: T.TEXT.TEXT,
    min: 0,
    max: 0,
    keep_history: false,
  }),
  [KINDS.CIRCUIT]: select,
  [KINDS.WATER_TEMP]: sensor({
    category: C.TEMPERATURE_SENSOR,
    type: T.SENSOR.DECIMAL,
    unit: U.CELSIUS,
    min: -10,
    max: 60,
  }),
  [KINDS.SETPOINT]: {
    category: C.THERMOSTAT,
    type: T.THERMOSTAT.TARGET_TEMPERATURE,
    unit: U.CELSIUS,
    min: SETPOINT.minC,
    max: SETPOINT.maxC,
    read_only: false,
    has_feedback: true,
    keep_history: true,
  },
  [KINDS.HEAT_MODE]: select,
  [KINDS.HEATING]: sensor({ category: C.UNKNOWN, type: T.SENSOR.BINARY, min: 0, max: 1 }),
  [KINDS.PUMP_RUNNING]: sensor({ category: C.UNKNOWN, type: T.SENSOR.BINARY, min: 0, max: 1 }),
  [KINDS.PUMP_RPM]: sensor({ category: C.UNKNOWN, type: T.SENSOR.INTEGER, min: 0, max: 5000 }),
  [KINDS.PUMP_POWER]: sensor({
    category: C.ENERGY_SENSOR,
    type: T.ENERGY_SENSOR.POWER,
    unit: U.WATT,
    min: 0,
    max: 5000,
  }),
  [KINDS.SENSOR_TEMP]: sensor({
    category: C.TEMPERATURE_SENSOR,
    type: T.SENSOR.DECIMAL,
    unit: U.CELSIUS,
    min: -40,
    max: 80,
  }),
  [KINDS.PH]: sensor({
    category: C.PH_SENSOR,
    type: T.PH_SENSOR.DECIMAL,
    unit: U.PH,
    min: 0,
    max: 14,
  }),
  [KINDS.ORP]: sensor({
    category: C.ORP_SENSOR,
    type: T.ORP_SENSOR.DECIMAL,
    unit: U.MILLI_VOLT,
    min: 0,
    max: 2000,
  }),
  [KINDS.PH_SETPOINT]: sensor({
    category: C.PH_SENSOR,
    type: T.PH_SENSOR.DECIMAL,
    unit: U.PH,
    min: 0,
    max: 14,
    keep_history: false,
  }),
  [KINDS.ORP_SETPOINT]: sensor({
    category: C.ORP_SENSOR,
    type: T.ORP_SENSOR.DECIMAL,
    unit: U.MILLI_VOLT,
    min: 0,
    max: 2000,
    keep_history: false,
  }),
  [KINDS.SALT]: sensor({ category: C.UNKNOWN, type: T.SENSOR.INTEGER, min: 0, max: 20000 }),
};

const KIND_LIST = Object.values(KINDS);

/** The kinds that take a command. */
export const COMMAND_KINDS = [KINDS.CIRCUIT, KINDS.SETPOINT, KINDS.HEAT_MODE];

export const panelIds = (gladys, id) => gladys.externalIds('intellicenter', id);

export const roleOf = (kind, objnam) => `${kind}-${objnam}`;

/** The role of a feature: `status`, or `{ kind, objnam }`; undefined when not ours. */
export function parseRole(role) {
  if (role === STATUS_ROLE) {
    return { kind: STATUS_ROLE };
  }
  if (typeof role !== 'string') return undefined;
  const cut = role.lastIndexOf('-');
  if (cut <= 0) return undefined;
  const kind = role.slice(0, cut);
  const objnam = role.slice(cut + 1);
  return KIND_LIST.includes(kind) && OBJNAM.test(objnam) ? { kind, objnam } : undefined;
}

/** The panel id and the role of one of our feature external ids, else undefined. */
export function parseFeatureId(externalId) {
  if (typeof externalId !== 'string' || externalId.length > 300) {
    return undefined;
  }
  const match = /:intellicenter:([0-9a-f]{16}):([A-Za-z0-9_-]{1,40})$/.exec(externalId);
  if (!match) return undefined;
  const role = parseRole(match[2]);
  return role ? { id: match[1], role: match[2], ...role } : undefined;
}

/** The panel id of one of our device external ids, else undefined. */
export function parseDeviceId(externalId) {
  if (typeof externalId !== 'string' || externalId.length > 300) {
    return undefined;
  }
  const match = /:intellicenter:([0-9a-f]{16})$/.exec(externalId);
  return match && PANEL_ID.test(match[1]) ? match[1] : undefined;
}

export const circuitOptions = (language) =>
  Object.values(CIRCUIT_VALUES).map((value) => ({
    value,
    label: word(CIRCUIT_LABELS[value], language),
  }));

export const heatModeOptions = (language) =>
  Object.keys(HEAT_MODES).map((value) => ({
    value,
    label: word(HEAT_MODE_LABELS[value], language),
  }));

/** The name of an object as shown: its own, else its kind and objnam. */
export function objectName(object, objnam, language) {
  if (object?.name) return object.name;
  const kind = OBJECT_NAMES[object?.type] ?? OBJECT_NAMES.CIRCUIT;
  return `${word(kind, language)} ${objnam}`;
}

/** The kinds of features of one object of the panel. */
export function kindsOf(object) {
  switch (object.type) {
    case 'BODY':
      return [KINDS.WATER_TEMP, KINDS.SETPOINT, KINDS.HEAT_MODE, KINDS.HEATING];
    case 'CIRCUIT':
      return [KINDS.CIRCUIT];
    case 'PUMP':
      return [KINDS.PUMP_RUNNING, KINDS.PUMP_RPM, KINDS.PUMP_POWER];
    case 'SENSE':
      return [KINDS.SENSOR_TEMP];
    case 'CHEM':
      return object.subtype === 'ICHEM'
        ? [KINDS.PH, KINDS.ORP, KINDS.PH_SETPOINT, KINDS.ORP_SETPOINT]
        : [KINDS.SALT];
    default:
      return [];
  }
}

function featureOf(ids, kind, objnam, name, language) {
  const options =
    kind === KINDS.CIRCUIT
      ? { supported_options: circuitOptions(language) }
      : kind === KINDS.HEAT_MODE
        ? { supported_options: heatModeOptions(language) }
        : {};
  return {
    name,
    external_id: ids.feature(objnam === undefined ? kind : roleOf(kind, objnam)),
    ...DEFINITIONS[kind],
    ...options,
  };
}

export const deviceName = (panel) => panel.name ?? `IntelliCenter ${panel.id.slice(0, 6)}`;

/**
 * The Gladys device of the panel: the status, then the features of every
 * object shown, then those of the created device the panel no longer shows
 * (kept with their name). `created`: the device as Gladys has it, or undefined.
 */
export function buildDevice(gladys, panel, { language, created } = {}) {
  const ids = panelIds(gladys, panel.id);
  const features = [
    featureOf(ids, STATUS_ROLE, undefined, word(FEATURE_NAMES[STATUS_ROLE], language), language),
  ];
  const groups = groupObjects(panel.objects);
  for (const object of [
    ...groups.bodies,
    ...groups.circuits,
    ...groups.pumps,
    ...groups.sensors,
    ...groups.chems,
  ]) {
    const name = objectName(object, object.objnam, language);
    for (const kind of kindsOf(object)) {
      features.push(
        featureOf(
          ids,
          kind,
          object.objnam,
          `${name} - ${word(FEATURE_NAMES[kind], language)}`,
          language,
        ),
      );
    }
  }
  const have = new Set(features.map((f) => f.external_id));
  for (const f of created?.features ?? []) {
    const parsed = parseFeatureId(f?.external_id);
    if (!parsed || parsed.id !== panel.id || have.has(f.external_id) || !parsed.objnam) continue;
    const name =
      typeof f.name === 'string' && f.name.trim() !== '' ? f.name.slice(0, 100) : parsed.role;
    features.push(featureOf(ids, parsed.kind, parsed.objnam, name, language));
    have.add(f.external_id);
  }
  const params = [];
  if (panel.version) params.push({ name: 'firmware', value: panel.version });
  return {
    name: deviceName(panel),
    external_id: ids.device,
    model: 'IntelliCenter',
    should_poll: false,
    features,
    params,
  };
}

/** The key of a heat mode code ('1' -> 'off'), else undefined. */
export const heatModeKey = (code) => Object.keys(HEAT_MODES).find((k) => HEAT_MODES[k] === code);

/** The value of one feature, from the objects read: `{ state }`, `{ text }` or undefined. */
export function valueOf(kind, object, { unit }) {
  const v = object.values;
  const inRange = (value) => {
    const { min, max } = DEFINITIONS[kind];
    return value !== undefined && Number.isFinite(value) && value >= min && value <= max
      ? { state: value }
      : undefined;
  };
  const positive = (value) => (value !== undefined && value > 0 ? inRange(value) : undefined);
  switch (kind) {
    case KINDS.CIRCUIT:
      return v.STATUS === 'ON' ? { text: 'on' } : v.STATUS === 'OFF' ? { text: 'off' } : undefined;
    case KINDS.WATER_TEMP:
      // Only while the body runs (its circuit on): off, the panel keeps an old water temperature.
      return v.STATUS === 'ON' ? inRange(celsiusOf(v.TEMP, unit)) : undefined;
    case KINDS.SETPOINT:
      return inRange(celsiusOf(v.LOTMP, unit));
    case KINDS.HEAT_MODE: {
      const key = heatModeKey(v.MODE);
      return key ? { text: key } : undefined;
    }
    case KINDS.HEATING: {
      const htmode = integerOf(v.HTMODE);
      return htmode === undefined || htmode < 0 ? undefined : { state: htmode > 0 ? 1 : 0 };
    }
    case KINDS.PUMP_RUNNING:
      return v.STATUS === PUMP_ON ? { state: 1 } : v.STATUS === PUMP_OFF ? { state: 0 } : undefined;
    case KINDS.PUMP_RPM:
      return inRange(integerOf(v.RPM));
    case KINDS.PUMP_POWER:
      return inRange(integerOf(v.PWR));
    case KINDS.SENSOR_TEMP:
      return inRange(celsiusOf(v.SOURCE, unit));
    case KINDS.PH:
      return positive(numberOf(v.PHVAL));
    case KINDS.ORP:
      return positive(numberOf(v.ORPVAL));
    case KINDS.PH_SETPOINT:
      return positive(numberOf(v.PHSET));
    case KINDS.ORP_SETPOINT:
      return positive(numberOf(v.ORPSET));
    case KINDS.SALT:
      return positive(integerOf(v.SALT));
    default:
      return undefined;
  }
}

/**
 * The current values of the panel's device, from one read. Offline: only the
 * status (Gladys keeps the last value of the others). A value that is not
 * known (or a text where a number is expected) is never published.
 */
export function deviceStates(ids, panel, { online, language }) {
  const states = [
    {
      device_feature_external_id: ids.feature(STATUS_ROLE),
      text: word(online ? STATE_TEXTS.online : STATE_TEXTS.offline, language),
    },
  ];
  if (!online) return states;
  const groups = groupObjects(panel.objects);
  for (const object of [
    ...groups.bodies,
    ...groups.circuits,
    ...groups.pumps,
    ...groups.sensors,
    ...groups.chems,
  ]) {
    for (const kind of kindsOf(object)) {
      const value = valueOf(kind, object, { unit: panel.unit });
      if (value) {
        states.push({
          device_feature_external_id: ids.feature(roleOf(kind, object.objnam)),
          ...value,
        });
      }
    }
  }
  return states;
}
