// -----------------------------------------------------------------------------
// Pentair IntelliCenter constants, manifest keys, limits and timings.
//
// An IntelliCenter panel (i5P, i7+3, i8PS, i10PS, i10+3D) answers a JSON
// protocol on TCP port 6681 of the local network, without credentials:
// one JSON object per line, ended by CR LF. A request carries `messageID` and
// `command`; its answer carries the same `messageID` and `response` ("200" when
// done). Only these commands are sent (as pyintellicenter 0.3.2 does, MIT):
//   - `GetParamList`: values of objects (`objectList: [{ objnam, keys }]`; the
//     object `INCR` with `condition: ""` asks for every object, with
//     `condition: "OBJTYP=SYSTEM"` for the system); a key the object does not
//     have comes back with its own name as value (`"PHVAL": "PHVAL"`);
//   - `SETPARAMLIST`: writes (`objectList: [{ objnam, params }]`).
// The panel may also send `NotifyList` lines (changes pushed after a
// `RequestParamList`, which this module never sends): they are ignored.
// -----------------------------------------------------------------------------

export const DEFAULT_PORT = 6681;

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;

export const COMMANDS = {
  GET: 'GetParamList',
  SET: 'SETPARAMLIST',
};

/** The keys of the system object read (`OBJTYP=SYSTEM`): name, firmware, units, unique name. */
export const SYSTEM_KEYS = ['PROPNAME', 'VER', 'MODE', 'SNAME'];

/** The keys of every object read by a poll (one request, the object `INCR`). */
export const OBJECT_KEYS = [
  'OBJTYP',
  'SUBTYP',
  'SNAME',
  'STATUS',
  'BODY',
  'FEATR',
  'TEMP',
  'LOTMP',
  'MODE',
  'HTMODE',
  'RPM',
  'PWR',
  'SOURCE',
  'PHVAL',
  'ORPVAL',
  'PHSET',
  'ORPSET',
  'SALT',
  'SINDEX',
];

/** The keys a command reads on its targets just before writing, and reads back. */
export const COMMAND_KEYS = ['OBJTYP', 'SUBTYP', 'STATUS', 'BODY', 'MODE', 'LOTMP'];

/** Circuit sub-types of lights (pyintellicenter LIGHT_SUBTYPES, plus the light shows). */
export const LIGHT_SUBTYPES = new Set([
  'LIGHT',
  'INTELLI',
  'GLOW',
  'GLOWT',
  'DIMMER',
  'MAGIC2',
  'LITSHO',
]);

/** Circuit sub-types of a body circuit: turning it on starts the pump of the body (and its heating). */
export const BODY_SUBTYPES = new Set(['POOL', 'SPA']);

/** `STATUS` of a circuit; of a pump: "10" running, "4" stopped. */
export const ON = 'ON';
export const OFF = 'OFF';
export const PUMP_ON = '10';
export const PUMP_OFF = '4';

/**
 * The heat modes of a body (`MODE`, pyintellicenter HeaterType): the key is
 * the value of our select (frozen: scenes keep it), the code what the panel
 * reads and writes. "off" is the protective one.
 */
export const HEAT_MODES = {
  off: '1',
  heater: '2',
  'solar-only': '3',
  'solar-preferred': '4',
  ultratemp: '5',
  'ultratemp-preferred': '6',
  'hybrid-gas': '7',
  'hybrid-heat-pump': '8',
  hybrid: '9',
  'hybrid-dual': '10',
  mastertemp: '11',
  'max-e-therm': '12',
  'eti-250': '13',
};
export const HEAT_OFF = HEAT_MODES.off;

/**
 * Heating set points, on the value written: the manufacturer's range of a
 * body (40 to 104 °F, 4 to 40 °C), a spa never above 40 °C, a pool never above
 * the ceiling of the configuration (35 °C by default, 40 °C at most).
 */
export const SETPOINT = {
  minC: 4,
  maxC: 40,
  minF: 40,
  maxF: 104,
  spaMaxC: 40,
  poolCeilingDefault: 35,
  poolCeilingMin: 10,
  poolCeilingMax: 40,
};

/** Feature kinds (the first part of a feature role, before the object name): frozen. */
export const KINDS = {
  CIRCUIT: 'circuit',
  WATER_TEMP: 'water-temp',
  SETPOINT: 'setpoint',
  HEAT_MODE: 'heat-mode',
  HEATING: 'heating',
  PUMP_RUNNING: 'pump-running',
  PUMP_RPM: 'pump-rpm',
  PUMP_POWER: 'pump-power',
  SENSOR_TEMP: 'sensor-temp',
  PH: 'ph',
  ORP: 'orp',
  PH_SETPOINT: 'ph-setpoint',
  ORP_SETPOINT: 'orp-setpoint',
  SALT: 'salt',
  SATURATION: 'saturation-index',
};

/** The one feature of the panel itself. */
export const STATUS_ROLE = 'status';

/** The values of the circuit select (frozen). */
export const CIRCUIT_VALUES = { on: 'on', off: 'off' };

export const ACTIONS = {
  TEST_CONNECTION: 'test_connection',
};

/** The poll interval of the configuration, in seconds. */
export const POLL_INTERVAL = {
  min: 15,
  default: 30,
  max: 600,
};

export const LIMITS = {
  /** One line (one JSON answer) never longer than this: a longer one closes the connection. */
  maxLineBytes: 1024 * 1024,
  /** Lines that are not the answer awaited (NotifyList...), per request, before giving up. */
  maxOtherLines: 200,
  /** Objects taken from one answer (a panel has a few dozen). */
  maxObjects: 1000,
  /** The objects of one kind shown (circuits, pumps...). */
  maxPerKind: 64,
  /** A name of the panel shown: cut to this many characters. */
  maxName: 40,
  /** Gladys accepts 300 states per minute; 100 per request. */
  statesPerMinute: 300,
  statesPerRequest: 100,
  /** Commands of one batch (one SETPARAMLIST). */
  maxBatch: 32,
};

/** An object name of the panel: letters, digits, underscore (B1101, C0006, P0001). */
export const OBJNAM = /^[A-Za-z0-9_]{1,16}$/;

export const TIMINGS = {
  /** Opening the TCP connection (a panel on the LAN answers in milliseconds). */
  connectTimeout: 3 * SECOND,
  /** One request of the polling (the answer to the whole object list included). */
  readTimeout: 8 * SECOND,
  /** A connection closed: the panel gets this long to close its side, then it is cut. */
  gracefulClose: 300,
  /** The connection is closed after this long without a request (a new one at the next). */
  idleClose: 20 * SECOND,
  /** Failed reads: 30 s, 1, 2, then 5 minutes, never shorter than the interval. */
  backoff: [30 * SECOND, MINUTE, 2 * MINUTE, 5 * MINUTE],
  /** The time of the last read is written to /data at most this often, before the read. */
  attemptWriteEvery: MINUTE,
  /** `getConfig()` failed: tried again this often, forever. */
  configRetry: 30 * SECOND,
  /** The publisher sends what is pending every second; unchanged states again every 30 min. */
  flushInterval: SECOND,
  stateHeartbeat: 30 * MINUTE,
  /** Values older than this are never sent as new (reconnection, device created). */
  freshFor: 2 * MINUTE,
  /**
   * Commands (Gladys waits 5 s for the ack): the write must leave by 3.5 s
   * after the click, or the command is refused unsent; the ack comes by
   * 4.3 s, after which the command is "sent, without confirmation".
   */
  commandSendBy: 3_500,
  commandAnswerBy: 4_300,
  /** The least time a request of a command gets. */
  commandMinRequest: 250,
  /** Commands arriving together (a scene) wait this long to go in one write. */
  commandGather: 30,
  /** After a write, the read back waits this long. */
  applyWait: 400,
  /** Reads after a command, spaced: its effect, then a check. */
  followUps: [5 * SECOND, 20 * SECOND],
  /** A command not confirmed: a new one is always sent for this long (never "already so"). */
  pendingFor: 90 * SECOND,
  /** The stop: tried again every 250 ms until 3 s after the click. */
  stopRetry: 250,
  stopRetryFor: 3_000,
  /** One try of the stop never waits longer than this for the answer. */
  stopTryTimeout: 2 * SECOND,
  /** The stop waits at most this long for /data before its first byte (a failing disk never holds it). */
  stopSaveWait: 200,
  /** A stop not seen applied: checked every 15 s. */
  stopCheck: 15 * SECOND,
  /** A read begun less than this after a stop left does not judge it "not applied". */
  stopApplyDelay: 2 * SECOND,
  /** Writes of a stop the panel accepted without effect before it is held (no more writes). */
  stopResends: 3,
  /** A command that left less than this before a stop may land after it: the stop watches. */
  stopWatchFor: 30 * SECOND,
};
