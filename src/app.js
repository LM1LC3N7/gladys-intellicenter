// -----------------------------------------------------------------------------
// The integration: the IntelliCenter panel typed in the configuration (one
// address, no credentials), one read of it every poll interval, its Gladys
// device and states, the transport badge, the "Test the connection" button,
// the commands (circuits and pumps, lights, heating: each only when the
// configuration allows it) and the stops (never held back). index.js only
// wires the SDK handlers to it.
//
// One request at a time on one TCP connection (src/lane.js): the reads of a
// poll, a batch of commands (its fresh read, its write, its read back), the
// stops and their checks.
//
// Reads:
//   - never sooner than the interval after the last one: not for the test
//     button, a Discovery scan, a reconnection to Gladys, a configuration
//     saved unchanged, nor a restart (the time of the last read is kept in
//     /data, written at most once a minute, BEFORE the read); only the reads
//     that follow a command (5 s, 20 s);
//   - the system first (its `SNAME` is the id of the device, its `MODE` the
//     unit), then every object;
//   - a read begun before a write left is not applied; values older than 2
//     minutes are never sent as new.
//
// Commands (a circuit on, a heat source, a heating set point):
//   - refused unless the configuration allows them ("circuits and pumps",
//     "lights", "heating"), checked on arrival and again right before the
//     write (in `beforeSend`, nothing in between); turning on a body circuit
//     (pool, spa: its pump) whose heat mode is not off also needs "heating";
//   - decided on a fresh read (identity, the objects, the unit), never on the
//     state in memory; refused when a value they need is missing;
//   - set points bounded on the whole degree written, after the conversion to
//     °F when the panel is in °F: 4 °C (40 °F) to 40 °C (104 °F) for a spa, to
//     the pool ceiling of the configuration (35 °C by default) for a pool;
//   - commands arriving together (a scene) go in one write; each leaves by
//     3.5 s after its click or not at all, is answered by 4.3 s, and is
//     confirmed only by a read back showing what was asked ("sent, not
//     applied yet" when it shows what was there before).
//
// The stops (a circuit off, a heat mode off) protect: never held back by the
// options, a read or a command in progress (they end them), a failed read, a
// panel never read, nor a configuration not read yet (they go to the address
// of the last read kept in /data, and the stops kept there are sent again at
// the start of the container, before the configuration). A command that
// arrived before a stop and has not left gives way. Tried again every 250 ms
// for 3 s; not seen applied, a stop is kept in /data and checked every 15 s:
// written again while the panel does not show it (3 accepted writes at most,
// then held and said in the status), let go when the panel shows it, or when
// a newer command for the same setting clicked in Gladys left. Never by time.
//
// Clocks: `monotonic` paces everything in memory (reads, retries, waits,
// deadlines), so that a wall clock moved by NTP never stops nor hurries
// them; the wall clock only dates what /data keeps for the next process.
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { addressKey, normalizeConfig, sameAddress } from './config.js';
import {
  CIRCUIT_VALUES,
  COMMAND_KEYS,
  COMMANDS,
  HEAT_MODES,
  HEAT_OFF,
  KINDS,
  LIMITS,
  OBJECT_KEYS,
  OFF,
  ON,
  SECOND,
  SYSTEM_KEYS,
  TIMINGS,
} from './constants.js';
import {
  COMMAND_KINDS,
  buildDevice,
  deviceName,
  deviceStates,
  objectName,
  panelIds,
  parseDeviceId,
  parseFeatureId,
} from './devices.js';
import { ERRORS, T, age, join, word } from './i18n.js';
import { ERROR_KINDS, PanelClient, PanelError, errorReason } from './ic/client.js';
import {
  bodyOfCircuit,
  ceilingOf,
  integerOf,
  groupObjects,
  isBodyCircuit,
  isLight,
  parseObjects,
  parseSystem,
  setpointToWrite,
} from './ic/model.js';
import { Lane } from './lane.js';
import { StatePublisher } from './publisher.js';
import { fileStore, normalizeMemory } from './store.js';

const SYSTEM_QUERY = {
  condition: 'OBJTYP=SYSTEM',
  objectList: [{ objnam: 'INCR', keys: SYSTEM_KEYS }],
};
const OBJECTS_QUERY = { condition: '', objectList: [{ objnam: 'INCR', keys: OBJECT_KEYS }] };

/** The key of a stop: its address and what it writes. */
const stopKey = (target, objnam, attr) => `${target.host}:${target.port}|${objnam}|${attr}`;
const settingKey = (objnam, attr) => `${objnam}|${attr}`;

/**
 * Whether a body heats, or may: its heat mode not seen Off, or heating still
 * reported (HTMODE not 0; unreadable counts as heating).
 */
const heatsBody = (body) =>
  !body || body.values.MODE !== HEAT_OFF || integerOf(body.values.HTMODE) !== 0;

/** The option names of the status and the errors. */
const OPTION_TEXTS = {
  circuits: T.optionCircuits,
  lights: T.optionLights,
  heating: T.optionHeating,
};

/** A value of a select command: a short string, trimmed; else undefined. */
function selectValue(value) {
  return typeof value === 'string' && value.length <= 40 ? value.trim() : undefined;
}

/** A set point asked: a finite number, or a strict decimal text ("28", "28.5"); never "", true, null. */
function setpointValue(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string' && /^\s*-?\d{1,3}(?:\.\d{1,3})?\s*$/.test(value)) {
    return Number(value.trim());
  }
  return undefined;
}

const freshPanel = () => ({
  id: undefined,
  name: undefined,
  version: undefined,
  unit: undefined,
  objects: undefined,
  /** Monotonic time the last applied read started (-Infinity: none). */
  readAt: -Infinity,
  online: undefined,
  failures: 0,
  wait: undefined,
  error: undefined,
  timer: undefined,
  running: undefined,
  followUps: new Set(),
});

export class IntelliCenterApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'intellicenter' }),
    connect,
    now = Date.now,
    monotonic = () => performance.now(),
    timers = globalThis,
    store = fileStore(),
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.now = now;
    this.monotonic = monotonic;
    this.timers = timers;
    this.store = store;
    this.client = new PanelClient({ connect, timers, now: monotonic });
    this.publisher = new StatePublisher({ gladys, logger, now: monotonic, timers });
    this.lane = new Lane();
    this.config = normalizeConfig();
    this.memory = normalizeMemory(null, now());
    /** /data could not be read: never overwritten (a guess would lose what it holds). */
    this.memoryUnreadable = false;
    this.memoryLoaded = undefined;
    this.panel = freshPanel();
    this.generation = 0;
    this.started = false;
    this.configRead = false;
    this.configSeq = 0;
    this.savedRaw = undefined;
    this.configChain = Promise.resolve();
    this.configTimer = undefined;
    /** Monotonic time of the last read sent (never sooner than the interval). */
    this.lastAttemptAt = -Infinity;
    this.attemptSavedAt = -Infinity;
    this.lastStatus = undefined;
    this.published = undefined;
    this.badge = undefined;
    /** Monotonic time the last write left (a read begun before it is not applied). */
    this.lastSentAt = -Infinity;
    /** objnam -> monotonic time a command (not a stop) last left for it. */
    this.lastOnSentAt = new Map();
    /** setting key -> monotonic end: a command sent and not confirmed (never "already so" meanwhile). */
    this.pending = new Map();
    /**
     * Stop keys (address and setting) a command of this run left for without
     * a refusal (200, or no answer): newer than any stop kept in /data, which
     * never undoes it (a /data read late, src: adoptStops).
     */
    this.commandsLeft = new Set();
    /** Commands waiting for their batch, and the worker running the batches. */
    this.commandQueue = [];
    this.commandWorker = undefined;
    /** Counts the stops: a command that arrived before the current count gives way. */
    this.protectSeq = 0;
    this.stops = [];
    this.stopWorker = undefined;
    /** stop key -> the stop not seen applied. */
    this.guards = new Map();
    /** address key -> { timer, dueAt }: the check of the stops of each address. */
    this.checks = new Map();
    /** The address keys whose check runs now. */
    this.checking = new Set();
    /** The stops clicked while no address was known: sent first once one is. */
    this.addressless = [];
    /** The JSON of the stops last saved to /data with success. */
    this.savedStops = '[]';
  }

  /** The monotonic clock (every in-memory time). */
  mono() {
    return this.monotonic();
  }

  /** Waits `ms`; ends at once when `signal` aborts (a stop takes the line). */
  sleep(ms, signal) {
    return new Promise((resolve) => {
      if (signal?.aborted) {
        resolve();
        return;
      }
      const done = () => {
        this.timers.clearTimeout(timer);
        signal?.removeEventListener('abort', done);
        resolve();
      };
      const timer = this.timers.setTimeout(done, Math.max(0, ms));
      signal?.addEventListener('abort', done, { once: true });
    });
  }

  /**
   * `promise` raced against `ms`: `{ done: true, value }`, or `{ done: false }`
   * when the time ran out. Never an unbounded wait on the path of a stop.
   */
  async bounded(promise, ms) {
    let timer;
    const late = new Promise((resolve) => {
      timer = this.timers.setTimeout(() => resolve({ done: false }), Math.max(0, ms));
    });
    try {
      return await Promise.race([
        promise.then(
          (value) => ({ done: true, value }),
          () => ({ done: true, value: undefined }),
        ),
        late,
      ]);
    } finally {
      this.timers.clearTimeout(timer);
    }
  }

  refusal(text) {
    return new Error(word(text, this.config.language));
  }

  // --- /data -------------------------------------------------------------------

  /**
   * Loads /data once (the stops kept there belong to the whole run). Nothing
   * waits for it more than 2 s: past that, /data counts as unreadable (never
   * overwritten) until the load ends; a load that ends late is applied then
   * (its stops sent, the flag lifted). Only a real read error or invalid
   * JSON is unreadable for good.
   */
  loadMemory() {
    if (!this.memoryLoaded) {
      const load = (async () => {
        try {
          return (await this.store.load()) ?? { unreadable: true };
        } catch {
          return { unreadable: true };
        }
      })();
      this.memoryLoaded = (async () => {
        const first = await this.bounded(load, TIMINGS.loadWait);
        if (!first.done) {
          // Slow disk: go on as unreadable for now, apply the load when it ends.
          this.memoryUnreadable = true;
          this.logger.warn('IntelliCenter: /data is slow to read: not written until it is read');
          load.then((result) => this.lateLoad(result)).catch(() => {});
          return;
        }
        this.applyLoad(first.value);
      })().finally(() => this.flushAddressless());
    }
    return this.memoryLoaded;
  }

  /** The content of /data read in time. */
  applyLoad(result) {
    if (result?.unreadable) {
      this.memoryUnreadable = true;
      this.logger.warn(
        'IntelliCenter: /data/intellicenter-state.json cannot be read: it is never overwritten',
      );
      this.memory = normalizeMemory(null, this.now());
      return;
    }
    this.memory = normalizeMemory(result?.data ?? null, this.now());
    this.savedStops = JSON.stringify(this.memory.stops);
  }

  /**
   * /data read after the 2 s: merged into what this run already knows (a stop
   * kept in memory wins over the one of the file, a command of this run that
   * left drops the stop of its setting), its stops sent as at a start, and
   * /data written again from now on.
   */
  lateLoad(result) {
    if (result?.unreadable) {
      this.logger.warn('IntelliCenter: /data cannot be read: it is never overwritten');
      return;
    }
    const loaded = normalizeMemory(result?.data ?? null, this.now());
    // The panel read in this run, if any (only a read sets the target).
    const known = this.memory.target;
    this.memoryUnreadable = false;
    this.memory.target = this.memory.target ?? loaded.target;
    if (loaded.lastAttemptAt !== null) {
      this.memory.lastAttemptAt = Math.max(
        this.memory.lastAttemptAt ?? -Infinity,
        loaded.lastAttemptAt,
      );
      this.lastAttemptAt = Math.max(
        this.lastAttemptAt,
        this.mono() - (this.now() - loaded.lastAttemptAt),
      );
    }
    this.savedStops = JSON.stringify(loaded.stops);
    this.memory.stops = loaded.stops;
    this.logger.warn('IntelliCenter: /data read late: applied now');
    this.adoptStops(this.followPanel(loaded.stops, loaded.target, known));
    this.flushAddressless();
    this.persistStops().catch(() => {});
    this.saveMemory().catch(() => {});
  }

  async saveMemory() {
    if (this.memoryUnreadable) {
      return false;
    }
    try {
      await this.store.save(this.memory);
      return true;
    } catch (err) {
      this.logger.warn(`IntelliCenter: saving the state to /data failed: ${err.message}`);
      return false;
    }
  }

  /** The stops not seen applied, in /data. */
  persistStops() {
    const stops = [...this.guards.values()].map((g) => ({
      host: g.target.host,
      port: g.target.port,
      objnam: g.objnam,
      attr: g.attr,
      value: g.value,
      since: g.since,
      written: g.written,
      resends: g.resends,
    }));
    // Compared with the last save that succeeded: a failed one is tried again.
    const json = JSON.stringify(stops);
    if (json === this.savedStops) {
      return Promise.resolve(true);
    }
    this.memory.stops = stops;
    return this.saveMemory().then((ok) => {
      if (ok && JSON.stringify(this.memory.stops) === json) this.savedStops = json;
      return ok;
    });
  }

  /**
   * At the start of the container, before the configuration is read: the
   * stops kept in /data (not seen applied before the restart) are sent again
   * at once to the address they were sent to, without a read first. Those
   * held (written 4 times without effect) are only checked.
   */
  async boot() {
    await this.loadMemory();
    this.adoptStops(this.memory.stops);
  }

  /**
   * The stops of a /data read late, when this run already read the same
   * panel (same id) at another address: those of its old address follow it
   * (as `retargetStops` does for a read after the load).
   */
  followPanel(stops, from, known) {
    if (!known || !from?.id || known.id !== from.id || sameAddress(known, from)) {
      return stops;
    }
    return stops.map((s) =>
      sameAddress(s, from) ? { ...s, host: known.host, port: known.port } : s,
    );
  }

  /** Stops read from /data: kept as guards (never over one this run holds), the unheld sent now. */
  adoptStops(stops) {
    const send = new Map();
    let dropped = false;
    for (const kept of stops) {
      const target = { host: kept.host, port: kept.port };
      const key = stopKey(target, kept.objnam, kept.attr);
      if (this.guards.has(key)) continue;
      if (this.commandsLeft.has(key)) {
        // Clicked before the restart; a command of this setting left since
        // (a /data read late): the newer intent, never undone.
        this.logger.warn(
          `IntelliCenter: a stop kept in /data for ${kept.objnam} let go (a newer command left)`,
        );
        dropped = true;
        continue;
      }
      const guard = this.newGuard(target, kept);
      guard.since = kept.since;
      guard.written = kept.written;
      guard.resends = kept.resends;
      this.guards.set(key, guard);
      if (guard.written && guard.resends >= TIMINGS.stopResends) {
        this.logger.warn('IntelliCenter: a stop held in /data is checked again');
        continue;
      }
      const at = addressKey(target);
      if (!send.has(at)) send.set(at, { target, specs: [] });
      send.get(at).specs.push(kept);
    }
    for (const target of this.stopAddresses()) {
      this.armStopCheck(send.has(addressKey(target)) ? TIMINGS.stopCheck : 0, target);
    }
    for (const { target, specs } of send.values()) {
      this.logger.warn(`IntelliCenter: ${specs.length} stop(s) kept in /data sent again`);
      this.queueStop({ target, specs, received: this.mono(), fromBoot: true });
    }
    // /data without the stops let go (a restart never sends them again).
    if (dropped) this.persistStops().catch(() => {});
  }

  // --- Lifecycle -------------------------------------------------------------

  /**
   * `fresh`: started for a new address while running (a read may go at
   * once); otherwise (container start) the first read waits for the interval
   * after the last read kept in /data.
   */
  async start(raw = {}, { fresh = false } = {}) {
    this.stop();
    this.config = normalizeConfig(raw);
    const generation = this.generation;
    // A stop clicked before any address was known goes now, first.
    this.flushAddressless();
    await this.panel.running;
    await this.loadMemory();
    if (generation !== this.generation) {
      return;
    }
    this.panel = freshPanel();
    // The panel last read at this address: its id, shown offline until it is read again.
    const kept = this.memory.target;
    if (this.config.address && sameAddress(kept, this.config.address) && kept.id) {
      this.panel.id = kept.id;
    }
    this.published = undefined;
    this.badge = undefined;
    this.lastStatus = undefined;
    this.publisher.start();
    // The configuration is known now: the stops are checked at once.
    for (const target of this.stopAddresses()) this.armStopCheck(0, target);
    if (!this.config.address) {
      await this.publishAll();
      return;
    }
    await this.setStatus(false, this.status()[1], generation);
    if (generation !== this.generation) {
      return;
    }
    const wait = fresh ? 0 : this.firstWait();
    if (wait > 0) {
      this.schedule(wait);
      await this.publishAll();
      return;
    }
    await this.tick();
  }

  /** The wait before the first read after a container start, from the time kept in /data. */
  firstWait() {
    if (this.memoryUnreadable) {
      // The time of the last read is unknown: a whole interval.
      return this.interval;
    }
    const stored = this.memory.lastAttemptAt;
    if (stored === null) {
      return 0;
    }
    this.lastAttemptAt = Math.max(this.lastAttemptAt, this.mono() - (this.now() - stored));
    // A read may have left up to a minute after the time kept (written at most once a minute).
    const due = stored + TIMINGS.attemptWriteEvery + this.interval;
    return Math.min(this.interval, Math.max(0, due - this.now()));
  }

  stop() {
    this.generation += 1;
    this.clearTimer();
    if (this.configTimer) {
      this.timers.clearTimeout(this.configTimer);
      this.configTimer = undefined;
    }
    for (const handle of this.panel.followUps) {
      this.timers.clearTimeout(handle);
    }
    this.panel.followUps.clear();
    // A read of this configuration ends (a stop or its check has its own target).
    if (this.lane.holder?.kind === 'read') {
      this.lane.holder.controller.abort();
    }
    this.publisher.stop();
  }

  /** The container stops: every timer (the stops are in /data), /data written, the connection closed. */
  async shutdown() {
    this.stop();
    for (const check of this.checks.values()) this.timers.clearTimeout(check.timer);
    this.checks.clear();
    this.memory.lastAttemptAt = Number.isFinite(this.lastAttemptAt)
      ? this.now() - (this.mono() - this.lastAttemptAt)
      : this.memory.lastAttemptAt;
    await this.bounded(this.saveMemory(), 2 * SECOND);
    await this.client.close();
  }

  clearTimer() {
    if (this.panel.timer) {
      this.timers.clearTimeout(this.panel.timer);
      this.panel.timer = undefined;
    }
  }

  /**
   * Connected to Gladys: reads the configuration, tried again every 30 s
   * while it fails (with a status), forever, then `connected`.
   */
  async onConnected(getConfig) {
    if (this.configTimer) {
      this.timers.clearTimeout(this.configTimer);
      this.configTimer = undefined;
    }
    // A configuration saved after this request left wins over its answer.
    const seq = this.configSeq;
    let raw;
    try {
      raw = await getConfig();
    } catch (err) {
      this.logger.warn(`IntelliCenter: reading the configuration failed: ${err.message}`);
      await this.loadMemory();
      this.lastStatus = undefined;
      await this.setStatus(false, T.configUnreadable);
      this.configTimer = this.timers.setTimeout(() => {
        this.configTimer = undefined;
        this.onConnected(getConfig).catch(() => {});
      }, TIMINGS.configRetry);
      return;
    }
    await this.inOrder(() => this.connected(seq !== this.configSeq ? this.savedRaw : raw));
  }

  /** Configurations (read or saved) applied one at a time, in their order of arrival. */
  inOrder(fn) {
    const run = this.configChain.then(fn);
    this.configChain = run.catch(() => {});
    return run;
  }

  /**
   * Connected to Gladys. The first time, start; after a reconnection (Gladys
   * restarted), resend what Gladys keeps in memory only (status, Discovery
   * list, badge), without reading the panel nor sending old values.
   */
  async connected(raw = {}) {
    this.configRead = true;
    if (!this.started) {
      this.started = true;
      await this.start(raw);
      return;
    }
    if (this.needsRestart(raw)) {
      await this.start(raw, { fresh: true });
      return;
    }
    const previous = this.config;
    this.config = normalizeConfig(raw);
    this.published = undefined;
    this.badge = undefined;
    this.lastStatus = undefined;
    this.gladys.forgetPublishedStates?.();
    this.rescheduleOnNewInterval(previous);
    await this.publishAll();
  }

  /** Only a new address restarts (an interval only reschedules). */
  needsRestart(raw) {
    const next = normalizeConfig(raw);
    return (
      JSON.stringify(next.address ?? null) !== JSON.stringify(this.config.address ?? null) ||
      next.invalidHost !== this.config.invalidHost
    );
  }

  rescheduleOnNewInterval(previous) {
    const p = this.panel;
    if (
      this.config.pollInterval !== previous.pollInterval &&
      this.config.address &&
      !p.running &&
      p.online !== false &&
      p.timer
    ) {
      this.schedule(this.dueIn());
    }
  }

  /** The configuration saved: applied in order of arrival, the last one wins. */
  configUpdated(raw = {}) {
    this.configSeq += 1;
    this.savedRaw = raw;
    return this.inOrder(() => this.applyConfig(raw));
  }

  async applyConfig(raw) {
    this.configRead = true;
    if (!this.started || this.needsRestart(raw)) {
      this.started = true;
      await this.start(raw, { fresh: true });
      return;
    }
    const previous = this.config;
    this.config = normalizeConfig(raw);
    this.rescheduleOnNewInterval(previous);
    if (this.config.language !== previous.language) {
      this.published = undefined;
    }
    await this.publishAll();
  }

  async setStatus(connected, message, generation = this.generation) {
    if (generation !== this.generation) {
      return;
    }
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) {
      return;
    }
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${err.message}`));
  }

  // --- Polling ---------------------------------------------------------------

  get interval() {
    return this.config.pollInterval * SECOND;
  }

  /** The time until the next read may go (never sooner than the interval). */
  dueIn(mono = this.mono()) {
    return Math.max(0, this.lastAttemptAt + this.interval - mono);
  }

  /** The next read: after its backoff, else the interval. */
  schedule(delay) {
    const p = this.panel;
    this.clearTimer();
    const wait = delay ?? (p.online === false ? p.wait : this.interval);
    const generation = this.generation;
    p.timer = this.timers.setTimeout(
      () => {
        p.timer = undefined;
        if (generation === this.generation) {
          this.tick().catch((err) =>
            this.logger.error(`IntelliCenter refresh failed: ${err.message}`),
          );
        }
      },
      Math.max(0, wait ?? this.interval),
    );
  }

  /** One read at a time: a tick during a read joins it. */
  tick() {
    const p = this.panel;
    if (!p.running) {
      p.running = this.run().finally(() => {
        p.running = undefined;
      });
    }
    return p.running;
  }

  /** The time of this read, in memory and (at most once a minute) in /data, BEFORE it. */
  async noteAttempt() {
    const mono = this.mono();
    this.lastAttemptAt = mono;
    if (mono - this.attemptSavedAt >= TIMINGS.attemptWriteEvery) {
      this.attemptSavedAt = mono;
      this.memory.lastAttemptAt = this.now();
      // Bounded: a hung disk never stops the reads (nor a new configuration waiting for them).
      await this.bounded(this.saveMemory(), TIMINGS.saveWait);
    }
  }

  async run() {
    const generation = this.generation;
    let delay;
    await this.noteAttempt();
    const startedAt = this.mono();
    try {
      const read = await this.readAll(generation);
      if (generation !== this.generation) {
        return;
      }
      if (startedAt <= this.lastSentAt) {
        // Begun before a write left: it may show the state before it.
        this.logger.debug('IntelliCenter: read begun before a write, not applied');
      } else {
        this.applyRead(read, startedAt);
        await this.saveTarget();
        this.observeStops(read.objects, startedAt, this.config.address);
      }
    } catch (err) {
      if (generation !== this.generation) {
        return;
      }
      if (err?.kind === ERROR_KINDS.ABORTED) {
        // The line was taken (a stop): not a failure, nothing applied.
        this.logger.debug('IntelliCenter: read ended by a stop');
      } else {
        delay = this.failed(err);
      }
    }
    if (generation !== this.generation) {
      return;
    }
    await this.publishAll();
    if (generation === this.generation) {
      this.schedule(delay);
    }
  }

  /** One GetParamList on the line (a turn of its own: a command or a stop may pass between two). */
  async read(fields, generation) {
    const holder = await this.lane.acquire('read');
    try {
      if (generation !== this.generation) {
        throw new PanelError(ERROR_KINDS.ABORTED, 'Configuration changed');
      }
      return await this.client.request(this.config.address, COMMANDS.GET, fields, {
        timeoutMs: TIMINGS.readTimeout,
        signal: holder.signal,
      });
    } finally {
      holder.release();
    }
  }

  /** The system, then every object. */
  async readAll(generation) {
    const system = parseSystem(await this.read(SYSTEM_QUERY, generation));
    if (!system) {
      throw new PanelError(ERROR_KINDS.PROTOCOL, 'Not a panel', { notPanel: true });
    }
    const objects = parseObjects(await this.read(OBJECTS_QUERY, generation));
    if (!objects) {
      throw new PanelError(ERROR_KINDS.PROTOCOL, 'No object list');
    }
    return { system, objects };
  }

  /** A read answered: the panel as read. */
  applyRead({ system, objects }, startedAt) {
    const p = this.panel;
    if (p.id && p.id !== system.id) {
      this.logger.warn('IntelliCenter: another panel answers at this address');
    }
    p.online = true;
    p.failures = 0;
    p.wait = undefined;
    p.error = undefined;
    p.id = system.id;
    p.name = system.name;
    p.version = system.version;
    p.unit = system.unit;
    p.objects = objects;
    p.readAt = startedAt;
  }

  /** Keeps in /data the address and id of the panel read, when they changed. */
  async saveTarget() {
    const p = this.panel;
    const address = this.config.address;
    const kept = this.memory.target;
    if (!p.id || (sameAddress(kept, address) && kept.id === p.id)) {
      return;
    }
    if (kept && kept.id === p.id && !sameAddress(kept, address)) {
      // The same panel at a new address (DHCP, a host name typed): its kept
      // stops follow it.
      this.retargetStops(kept, address);
    }
    this.memory.target = { host: address.host, port: address.port, id: p.id };
    await this.bounded(this.saveMemory(), TIMINGS.saveWait);
  }

  /** A failed read: the delay before the next one (never sooner than the interval). */
  failed(err) {
    const p = this.panel;
    const reason = errorReason(err);
    const wait = Math.max(
      this.interval,
      TIMINGS.backoff[Math.min(p.failures, TIMINGS.backoff.length - 1)],
    );
    p.failures += 1;
    p.online = false;
    p.wait = wait;
    p.error = err?.notPanel ? 'not_panel' : (err?.kind ?? reason);
    this.logger.warn(`IntelliCenter: ${reason}; next try in ${Math.round(wait / 1000)} s`);
    return wait;
  }

  // --- Status ------------------------------------------------------------------

  /** The name of an object of the panel for the status. */
  nameOf(objnam) {
    return objectName(this.panel.objects?.get(objnam), objnam, this.config.language);
  }

  /** Where each stop not seen applied is, exactly (5 at most, then their count). */
  stopNotes() {
    const notes = [];
    for (const g of this.guards.values()) {
      let state;
      if (!g.written) state = 'notSent';
      else if (g.applied) state = 'watch';
      else if (g.heatingSince !== undefined && g.heatUnknown) state = 'heatUnknown';
      else if (g.heatingSince !== undefined) {
        state = this.mono() - g.heatingSince < TIMINGS.heatCoolDown ? 'coolDown' : 'stillHeating';
      } else if (g.resends >= TIMINGS.stopResends) state = 'held';
      else if (g.refusedCode !== undefined) state = 'refused';
      else state = 'waiting';
      notes.push(T.stopState(this.nameOf(g.objnam), g.attr, state, g.refusedCode));
    }
    if (notes.length > 5) {
      const more = notes.length - 5;
      return [...notes.slice(0, 5), { en: `(+${more})`, fr: `(+${more})` }];
    }
    return notes;
  }

  withNotes(message) {
    let text = message;
    for (const note of this.stopNotes()) {
      text = join(text, note);
    }
    return text;
  }

  /** The options turned off, for the status. */
  optionsOff() {
    const off = [];
    if (!this.config.allowCircuits) off.push(OPTION_TEXTS.circuits);
    if (!this.config.allowLights) off.push(OPTION_TEXTS.lights);
    if (!this.config.allowHeating) off.push(OPTION_TEXTS.heating);
    return off;
  }

  /** `[connected, message, plain]`; `plain`: the summary without "Connected". */
  status() {
    const p = this.panel;
    if (!this.config.address) {
      const message = this.config.invalidHost ? T.invalidHost(this.config.invalidHost) : T.noHost;
      return [false, this.withNotes(message)];
    }
    if (p.online === false) {
      const wait = age(p.wait ?? this.interval);
      let message;
      if (p.error === 'not_panel') message = T.notPanel;
      else if (
        [ERROR_KINDS.UNREACHABLE, ERROR_KINDS.TIMEOUT, ERROR_KINDS.CLOSED].includes(p.error)
      ) {
        message = T.unreachable(addressKey(this.config.address), wait);
      } else message = T.failing(p.error ?? 'error', wait);
      return [false, this.withNotes(message)];
    }
    if (p.online === undefined || !p.objects) {
      return [false, this.withNotes(T.connecting)];
    }
    let summary = T.summary({
      name: deviceName(p),
      circuits: groupObjects(p.objects).circuits.length,
      unit: p.unit,
    });
    const off = this.optionsOff();
    if (off.length > 0) {
      summary = join(summary, T.commandsOff(off));
    }
    summary = this.withNotes(summary);
    return [true, T.connected(summary), summary];
  }

  /** The connection status of the configuration screen. */
  async updateStatus(generation = this.generation) {
    const [connected, message, plain] = this.status();
    const orphans = this.orphans();
    if (orphans.length === 0) {
      await this.setStatus(connected, message, generation);
      return;
    }
    const names = orphans
      .map((id) => {
        const device = this.createdDevice(id);
        return typeof device?.name === 'string' && device.name !== ''
          ? `${device.name.slice(0, 60)} (${id.slice(0, 6)})`
          : id.slice(0, 6);
      })
      .join(', ');
    // Not connected: the message never starts with "Connected".
    await this.setStatus(false, join(plain ?? message, T.otherPanel(names)), generation);
  }

  // --- Gladys ----------------------------------------------------------------

  /** Whether the values of the last read may be sent as current (2 minutes at most). */
  fresh(mono = this.mono()) {
    return mono - this.panel.readAt <= TIMINGS.freshFor;
  }

  /** The panel to show and whether it is reachable; undefined while nothing is known. */
  shown() {
    const p = this.panel;
    if (p.id && p.objects && p.online !== false) {
      return { panel: p, online: true };
    }
    if (p.id && p.online === false) {
      return { panel: p, online: false };
    }
    return undefined;
  }

  /** The created device of a panel id, as Gladys has it. */
  createdDevice(id) {
    const external = panelIds(this.gladys, id).device;
    return (this.gladys.devices ?? []).find((d) => d?.external_id === external);
  }

  /**
   * The ids of the devices created in Gladys that the panel read is not
   * (another panel at this address, or an address changed). Empty until a
   * read succeeded since the start (a panel down is not "another panel"),
   * unless there is no address at all.
   */
  orphans() {
    const p = this.panel;
    if (this.config.address && p.readAt === -Infinity) {
      return [];
    }
    const ids = [];
    for (const device of this.gladys.devices ?? []) {
      const id = parseDeviceId(device?.external_id);
      if (id && id !== p.id && panelIds(this.gladys, id).device === device.external_id) {
        ids.push(id);
      }
    }
    return ids;
  }

  async publishAll() {
    const generation = this.generation;
    await this.publishDevices();
    this.queueStates();
    await this.flush();
    await this.publishBadge();
    await this.updateStatus(generation);
  }

  async flush() {
    await this.publisher
      .flush()
      .catch((err) => this.logger.warn(`Sending to Gladys failed: ${err.message}`));
  }

  async publishDevices() {
    const p = this.panel;
    if (!p.id || !p.objects || p.readAt === -Infinity) {
      return;
    }
    const devices = [
      buildDevice(this.gladys, p, {
        language: this.config.language,
        created: this.createdDevice(p.id),
      }),
    ];
    const json = JSON.stringify(devices);
    if (json === this.published) {
      return;
    }
    try {
      await this.gladys.publishDiscoveredDevices(devices);
      this.published = json;
    } catch (err) {
      this.logger.warn(`Publishing the discovered devices failed: ${err.message}`);
    }
  }

  createdFeatures() {
    return new Set(
      (this.gladys.devices ?? []).flatMap((d) => (d.features ?? []).map((f) => f.external_id)),
    );
  }

  /** The states to send: those of a fresh read only (offline: the status). */
  queueStates(created = this.createdFeatures()) {
    const push = (id, panel, online) => {
      const states = deviceStates(panelIds(this.gladys, id), panel, {
        online,
        language: this.config.language,
      });
      for (const { device_feature_external_id: featureId, ...value } of states) {
        if (created.has(featureId)) {
          this.publisher.push(featureId, value);
        }
      }
    };
    const shown = this.shown();
    if (shown && (!shown.online || this.fresh())) {
      push(shown.panel.id, shown.panel, shown.online);
    }
    // A created device the panel read is not: unreachable.
    for (const id of this.orphans()) {
      push(id, {}, false);
    }
  }

  async publishBadge() {
    const created = new Set((this.gladys.devices ?? []).map((d) => d.external_id));
    const entries = [];
    const shown = this.shown();
    const id = shown && panelIds(this.gladys, shown.panel.id).device;
    if (shown && created.has(id)) {
      entries.push({
        external_id: id,
        transport: shown.online ? DEVICE_TRANSPORTS.LOCAL : DEVICE_TRANSPORTS.UNREACHABLE,
      });
    }
    for (const orphan of this.orphans()) {
      entries.push({
        external_id: panelIds(this.gladys, orphan).device,
        transport: DEVICE_TRANSPORTS.UNREACHABLE,
      });
    }
    const json = JSON.stringify(entries);
    if (entries.length === 0 || json === this.badge) {
      return;
    }
    try {
      await this.gladys.publishTransports(entries);
      this.badge = json;
    } catch (err) {
      this.logger.warn(`Transport badge failed: ${err.message}`);
    }
  }

  /** A device was created (or updated): its last values at once, if fresh. */
  async deviceCreated(device) {
    this.badge = undefined;
    this.published = undefined;
    const created = this.createdFeatures();
    for (const f of device?.features ?? []) {
      created.add(f.external_id);
    }
    this.queueStates(created);
    await this.flush();
    await this.publishBadge();
  }

  /** A device was deleted: what is pending for it is dropped. */
  async deviceDeleted(device) {
    this.badge = undefined;
    this.published = undefined;
    if (typeof device?.external_id === 'string') {
      this.publisher.forget(device.external_id);
    }
  }

  /** The Discovery tab asks for a scan: the device of the last read, sent again (no read). */
  async scan() {
    this.published = undefined;
    await this.publishDevices();
  }

  /** Reads the panel now if the interval allows it, else the last status (never sooner). */
  async testConnection() {
    if (this.guards.size > 0) {
      // Stops kept (not sent, refused, not applied): checked and sent first, now.
      this.armStopCheck(0);
    }
    if (!this.config.address) {
      return this.status()[1];
    }
    const wait = this.dueIn();
    if (wait > 0 || this.panel.running) {
      await this.panel.running;
      const [, message] = this.status();
      return join(message, T.test.notSooner(age(this.dueIn())));
    }
    await this.tick();
    return this.status()[1];
  }

  // --- Commands --------------------------------------------------------------------

  async setValue(_device, feature, value) {
    // The deadlines count from the arrival of the command, before any wait.
    const received = this.mono();
    const parsed = parseFeatureId(feature?.external_id);
    if (!parsed || !COMMAND_KINDS.includes(parsed.kind)) {
      throw this.refusal(ERRORS.readOnly);
    }
    const { kind, objnam, id } = parsed;
    if (kind === KINDS.CIRCUIT) {
      const v = selectValue(value);
      if (v === CIRCUIT_VALUES.off) {
        // Never held back: whatever the option, a read or a command.
        return this.protect(received, { objnam, attr: 'STATUS', value: OFF });
      }
      if (v !== CIRCUIT_VALUES.on) throw this.refusal(ERRORS.badValue);
      return this.command({ kind, objnam, id, attr: 'STATUS', wanted: ON }, received);
    }
    if (kind === KINDS.HEAT_MODE) {
      const v = selectValue(value);
      if (v === 'off') {
        return this.protect(received, { objnam, attr: 'MODE', value: HEAT_OFF });
      }
      if (v === undefined || !Object.hasOwn(HEAT_MODES, v)) throw this.refusal(ERRORS.badValue);
      return this.command({ kind, objnam, id, attr: 'MODE', wanted: HEAT_MODES[v] }, received);
    }
    const celsius = setpointValue(value);
    if (celsius === undefined) throw this.refusal(ERRORS.badValue);
    return this.command({ kind, objnam, id, attr: 'LOTMP', celsius }, received);
  }

  /**
   * The options a command needs, from what is known of its object (the fresh
   * read when given, else the last read): `[...]` of 'circuits', 'lights',
   * 'heating'. `heats`: a body circuit whose heat mode is not seen off.
   */
  optionsFor(entry, object, heats) {
    if (entry.kind !== KINDS.CIRCUIT) return ['heating'];
    const options = [];
    if (object && isLight(object)) options.push('lights');
    else if (object) options.push('circuits');
    else
      options.push(this.config.allowLights && !this.config.allowCircuits ? 'lights' : 'circuits');
    if (heats) options.push('heating');
    return options;
  }

  /** The first option of `options` the configuration does not allow, else undefined. */
  missingOption(options) {
    const allowed = {
      circuits: this.config.allowCircuits,
      lights: this.config.allowLights,
      heating: this.config.allowHeating,
    };
    return options.find((o) => !allowed[o]);
  }

  /** The checks of a command, on arrival, before its batch, and right before the write. */
  admit(entry, options) {
    if (entry.seq !== this.protectSeq) {
      return ERRORS.stopMeanwhile;
    }
    if (entry.generation !== this.generation || !this.config.address) {
      return ERRORS.unknownPanel;
    }
    const missing = this.missingOption(options ?? entry.options);
    if (missing) {
      return missing === 'heating' && entry.kind === KINDS.CIRCUIT
        ? ERRORS.wouldHeat
        : ERRORS.disabled(OPTION_TEXTS[missing]);
    }
    if (this.mono() > entry.sendBy) {
      return ERRORS.tooSlow;
    }
    return undefined;
  }

  /** A command: queued for the next batch, answered by 4.3 s after its click. */
  async command(spec, received) {
    const entry = {
      ...spec,
      received,
      sendBy: received + TIMINGS.commandSendBy,
      answerBy: received + TIMINGS.commandAnswerBy,
      seq: this.protectSeq,
      generation: this.generation,
      sent: false,
      finished: false,
    };
    entry.options = this.optionsFor(entry, this.panel.objects?.get(spec.objnam), false);
    const early = this.admit(entry);
    if (early) {
      throw this.refusal(early);
    }
    if (!this.configRead) {
      throw this.refusal(ERRORS.notReadYet);
    }
    if (this.panel.id && spec.id !== this.panel.id) {
      throw this.refusal(ERRORS.unknownPanel);
    }
    const outcome = new Promise((resolve) => {
      entry.finish = (result) => {
        if (entry.finished) return;
        entry.finished = true;
        resolve(result);
      };
    });
    this.commandQueue.push(entry);
    this.kickCommands();
    let timer;
    const late = new Promise((resolve) => {
      timer = this.timers.setTimeout(
        () => resolve({ late: true }),
        Math.max(0, entry.answerBy - this.mono()),
      );
    });
    const result = await Promise.race([outcome, late]);
    this.timers.clearTimeout(timer);
    if (result.late) {
      // Not left by now: it never will (`admit` refuses it after 3.5 s).
      throw this.refusal(entry.sent ? ERRORS.sentUnconfirmed('no answer yet') : ERRORS.tooSlow);
    }
    if (result.error) {
      throw result.error;
    }
    return undefined;
  }

  kickCommands() {
    if (this.commandWorker) {
      return;
    }
    this.commandWorker = (async () => {
      try {
        while (this.commandQueue.length > 0) {
          // Commands arriving together (a scene) go in one write.
          await this.sleep(TIMINGS.commandGather);
          const batch = this.commandQueue.splice(0, LIMITS.maxBatch);
          try {
            await this.runBatch(batch);
          } catch (err) {
            this.logger.warn(`IntelliCenter: commands failed: ${err.message}`);
          }
          for (const entry of batch) {
            entry.finish({ error: this.refusal(ERRORS.unknownState('error')) });
          }
        }
      } finally {
        this.commandWorker = undefined;
      }
    })();
  }

  finishWith(entry, text) {
    entry.finish({ error: this.refusal(text) });
  }

  isPending(objnam, attr) {
    return (this.pending.get(settingKey(objnam, attr)) ?? -Infinity) > this.mono();
  }

  markPending(objnam, attr) {
    this.pending.set(settingKey(objnam, attr), this.mono() + TIMINGS.pendingFor);
  }

  /** A stop of this setting not seen applied, at the configured address. */
  guardOf(objnam, attr) {
    return this.config.address
      ? this.guards.get(stopKey(this.config.address, objnam, attr))
      : undefined;
  }

  /** Whether a heat stop is kept (not seen applied) at the configured address. */
  heatStopKept() {
    return [...this.guards.values()].some(
      (g) => g.attr === 'MODE' && sameAddress(g.target, this.config.address),
    );
  }

  /**
   * What to write for one command, from the fresh read: `{ write }`,
   * `{ skip: true }` (already so), or `{ refuse: text }`.
   */
  plan(entry, system, objects) {
    const object = objects.get(entry.objnam);
    if (entry.kind === KINDS.CIRCUIT) {
      if (object?.type !== 'CIRCUIT' || !object.values.STATUS) {
        return { refuse: ERRORS.unknownObject };
      }
      let heats = false;
      if (isBodyCircuit(object)) {
        // Its pump starts, and with it the heating of its body unless that is seen off.
        const body = bodyOfCircuit(object, objects);
        // During the heat stop of its body (not seen applied): refused, whatever is read.
        if (body ? this.guardOf(body, 'MODE') : this.heatStopKept()) {
          return { refuse: ERRORS.stopInProgress };
        }
        heats = !body || heatsBody(objects.get(body));
      } else if (object.subtype === 'CIRCGRP') {
        // A group ("Spa Mode") may turn a body on, and its heating: its members
        // are not read, so it heats unless every body is seen not heating.
        if (this.heatStopKept()) {
          return { refuse: ERRORS.stopInProgress };
        }
        const bodies = [...objects.values()].filter((o) => o.type === 'BODY');
        heats = bodies.length === 0 || bodies.some(heatsBody);
      }
      const options = this.optionsFor(entry, object, heats);
      const refused = this.admit(entry, options);
      if (refused) return { refuse: refused };
      if (
        object.values.STATUS === ON &&
        !this.isPending(entry.objnam, 'STATUS') &&
        !this.guardOf(entry.objnam, 'STATUS')
      ) {
        return { skip: true };
      }
      return {
        write: { value: ON, before: object.values.STATUS, options },
      };
    }
    if (object?.type !== 'BODY') {
      return { refuse: ERRORS.unknownObject };
    }
    const options = ['heating'];
    const refused = this.admit(entry, options);
    if (refused) return { refuse: refused };
    if (entry.kind === KINDS.HEAT_MODE) {
      if (!object.values.MODE) return { refuse: ERRORS.unknownObject };
      if (
        object.values.MODE === entry.wanted &&
        !this.isPending(entry.objnam, 'MODE') &&
        !this.guardOf(entry.objnam, 'MODE')
      ) {
        return { skip: true };
      }
      return { write: { value: entry.wanted, before: object.values.MODE, options } };
    }
    // The set point: a side effect that may restart the heating, refused during its stop.
    if (this.guardOf(entry.objnam, 'MODE')) {
      return { refuse: ERRORS.stopInProgress };
    }
    if (!system.unit) {
      return { refuse: ERRORS.unknownUnit };
    }
    const target = setpointToWrite(
      entry.celsius,
      system.unit,
      ceilingOf(object, this.config.poolCeiling),
    );
    if (!target) return { refuse: ERRORS.unknownUnit };
    if (target.value === undefined) {
      return { refuse: ERRORS.outOfBounds(target.low, target.high) };
    }
    if (object.values.LOTMP === target.value && !this.isPending(entry.objnam, 'LOTMP')) {
      return { skip: true };
    }
    return { write: { value: target.value, before: object.values.LOTMP, options } };
  }

  /**
   * One batch of commands on the line: a fresh read (the system, the objects
   * concerned and every body), the plans, one SETPARAMLIST, one read back.
   */
  async runBatch(batch) {
    let live = [];
    for (const entry of batch) {
      const refused = this.admit(entry);
      if (refused) this.finishWith(entry, refused);
      else live.push(entry);
    }
    if (live.length === 0) return;
    const address = this.config.address;
    const latest = Math.max(...live.map((e) => e.sendBy));
    // The line, or nothing sent: a turn that never comes by 3.5 s is given up.
    const giveUp = new AbortController();
    const giveUpTimer = this.timers.setTimeout(
      () => giveUp.abort(),
      Math.max(0, latest - TIMINGS.commandMinRequest - this.mono()),
    );
    let holder;
    try {
      holder = await this.lane.acquire('command', { signal: giveUp.signal });
    } catch {
      for (const entry of live) this.finishWith(entry, ERRORS.tooSlow);
      return;
    } finally {
      this.timers.clearTimeout(giveUpTimer);
    }
    try {
      await this.batchOnLine(live, address, holder, latest);
    } finally {
      holder.release();
    }
  }

  /** A failure before any write: every entry gets its reason. */
  failBeforeWrite(entries, err) {
    for (const entry of entries) {
      if (err?.kind === ERROR_KINDS.ABORTED && entry.seq !== this.protectSeq) {
        this.finishWith(entry, ERRORS.stopMeanwhile);
      } else if (err?.kind === ERROR_KINDS.LATE || this.mono() > entry.sendBy) {
        this.finishWith(entry, ERRORS.tooSlow);
      } else {
        this.finishWith(entry, ERRORS.unknownState(errorReason(err)));
      }
    }
  }

  async batchOnLine(entries, address, holder, latest) {
    let live = entries.filter((entry) => {
      const refused = this.admit(entry);
      if (refused) this.finishWith(entry, refused);
      return !refused;
    });
    if (live.length === 0) return;
    const readUntil = latest - TIMINGS.commandMinRequest;
    const options = () => ({
      timeoutMs: Math.max(TIMINGS.commandMinRequest, readUntil - this.mono()),
      signal: holder.signal,
    });
    let system;
    let objects;
    try {
      system = parseSystem(
        await this.client.request(address, COMMANDS.GET, SYSTEM_QUERY, options()),
      );
      if (!system) throw new PanelError(ERROR_KINDS.PROTOCOL, 'Not a panel');
      if (this.mono() >= readUntil) throw new PanelError(ERROR_KINDS.LATE, 'Too slow');
      // The objects of the commands and every body known (a body circuit needs its heat mode).
      const names = new Set(live.map((e) => e.objnam));
      for (const body of groupObjects(this.panel.objects).bodies) names.add(body.objnam);
      const query = {
        objectList: [...names].map((objnam) => ({ objnam, keys: COMMAND_KEYS })),
      };
      objects = parseObjects(
        await this.client.request(address, COMMANDS.GET, query, options()),
        COMMAND_KEYS,
      );
      if (!objects) throw new PanelError(ERROR_KINDS.PROTOCOL, 'No object list');
    } catch (err) {
      this.failBeforeWrite(live, err);
      return;
    }
    // The panel of each command: the one that answers, or nothing.
    live = live.filter((entry) => {
      if (entry.id !== system.id) this.finishWith(entry, ERRORS.otherPanel);
      return entry.id === system.id;
    });
    // The plans, in the order of arrival: a later command of the same setting replaces an earlier one.
    const planned = [];
    for (const entry of live) {
      const plan = this.plan(entry, system, objects);
      if (plan.refuse) {
        this.finishWith(entry, plan.refuse);
        continue;
      }
      if (plan.skip) {
        entry.finish({});
        continue;
      }
      const index = planned.findIndex(
        (p) => p.entry.objnam === entry.objnam && p.entry.attr === entry.attr,
      );
      if (index >= 0) {
        this.finishWith(planned[index].entry, ERRORS.replaced);
        planned.splice(index, 1);
      }
      planned.push({ entry, address, ...plan.write });
    }
    if (planned.length === 0) return;
    let sending = planned;
    const answerBy = Math.min(...planned.map((p) => p.entry.answerBy));
    try {
      await this.client.request(
        address,
        COMMANDS.SET,
        () => ({
          objectList: this.writesOf(sending.map((p) => [p.entry.objnam, p.entry.attr, p.value])),
        }),
        {
          timeoutMs: Math.max(
            TIMINGS.commandMinRequest,
            answerBy - TIMINGS.applyWait - this.mono(),
          ),
          signal: holder.signal,
          beforeSend: () => {
            // The options, the stops and the deadline checked again right before the byte.
            sending = sending.filter((p) => {
              const refused = this.admit(p.entry, p.options);
              if (refused) this.finishWith(p.entry, refused);
              return !refused;
            });
            if (sending.length === 0) throw new Error('nothing left to send');
            const at = this.mono();
            this.lastSentAt = at;
            for (const p of sending) {
              p.entry.sent = true;
              if (p.entry.kind !== KINDS.SETPOINT) this.lastOnSentAt.set(p.entry.objnam, at);
            }
          },
        },
      );
    } catch (err) {
      this.commandsFailed(err, sending);
      return;
    }
    this.newerThanStops(sending);
    for (const p of sending) this.markPending(p.entry.objnam, p.entry.attr);
    // The read back alone confirms them.
    await this.sleep(
      Math.min(TIMINGS.applyWait, answerBy - TIMINGS.commandMinRequest - this.mono()),
      holder.signal,
    );
    let back;
    try {
      const query = {
        objectList: [...new Set(sending.map((p) => p.entry.objnam))].map((objnam) => ({
          objnam,
          keys: COMMAND_KEYS,
        })),
      };
      back = parseObjects(
        await this.client.request(address, COMMANDS.GET, query, {
          timeoutMs: Math.max(TIMINGS.commandMinRequest, answerBy - this.mono()),
          signal: holder.signal,
        }),
        COMMAND_KEYS,
      );
    } catch {
      back = undefined;
    }
    this.followUp();
    for (const p of sending) {
      const value = back?.get(p.entry.objnam)?.values[p.entry.attr];
      if (!back) {
        this.finishWith(p.entry, ERRORS.sentUnconfirmed('no read back'));
      } else if (value === p.value) {
        this.pending.delete(settingKey(p.entry.objnam, p.entry.attr));
        this.logger.info(`IntelliCenter: ${p.entry.kind} ${p.entry.objnam} confirmed by the panel`);
        p.entry.finish({});
      } else {
        this.finishWith(p.entry, value === p.before ? ERRORS.notApplied : ERRORS.sentDiffers);
      }
    }
  }

  /**
   * Commands that left (a 200, or no clear refusal: they may be applied) for
   * a setting with a stop kept: the newer intent wins, the stop is let go,
   * never one clicked while they were on their way. Newer than any stop of
   * /data too (clicked before this run): noted for a /data read late.
   */
  newerThanStops(sent) {
    for (const p of sent) {
      if (p.entry.kind !== KINDS.SETPOINT) {
        this.commandsLeft.add(stopKey(p.address, p.entry.objnam, p.entry.attr));
      }
      if (p.entry.kind === KINDS.SETPOINT || p.entry.seq !== this.protectSeq) continue;
      const guard = this.guardOf(p.entry.objnam, p.entry.attr);
      if (guard) this.dropGuard(guard, 'newer command');
    }
  }

  /** A write that failed: never "nothing sent" once a byte may have left. */
  commandsFailed(err, sending) {
    const reason = errorReason(err);
    this.logger.warn(`IntelliCenter: commands failed (${reason})`);
    if (err.kind === ERROR_KINDS.YIELDED) {
      // Refused in beforeSend: each got its own words.
      return;
    }
    const left = sending.some((p) => p.entry.sent);
    if (!left) {
      this.failBeforeWrite(
        sending.map((p) => p.entry),
        err,
      );
      return;
    }
    this.followUp();
    if (err.kind === ERROR_KINDS.REFUSED) {
      for (const p of sending) this.finishWith(p.entry, ERRORS.refused(reason));
      return;
    }
    // A silence, a cut: they may have reached the panel.
    this.newerThanStops(sending);
    for (const p of sending) {
      this.markPending(p.entry.objnam, p.entry.attr);
      this.finishWith(p.entry, ERRORS.sentUnconfirmed(reason));
    }
  }

  /** The objectList of a SETPARAMLIST: one entry per object, its params gathered. */
  writesOf(triples) {
    const byObject = new Map();
    for (const [objnam, attr, value] of triples) {
      if (!byObject.has(objnam)) byObject.set(objnam, {});
      byObject.get(objnam)[attr] = value;
    }
    return [...byObject].map(([objnam, params]) => ({ objnam, params }));
  }

  /**
   * Spaced reads after a command: its effect, then a check (each a new read).
   * The reads of an earlier command not done yet are replaced.
   */
  followUp() {
    const generation = this.generation;
    const p = this.panel;
    for (const handle of p.followUps) {
      this.timers.clearTimeout(handle);
    }
    p.followUps.clear();
    for (const delay of TIMINGS.followUps) {
      const handle = this.timers.setTimeout(() => {
        p.followUps.delete(handle);
        if (generation === this.generation && this.config.address) {
          Promise.resolve(p.running)
            .then(() => this.tick())
            .catch(() => this.logger.error('IntelliCenter refresh failed'));
        }
      }, delay);
      p.followUps.add(handle);
    }
  }

  // --- The stops (protective) ---------------------------------------------------

  /** Where a stop goes: the configured address, else the last one read (in /data). */
  stopTarget() {
    if (this.config.address) {
      return { host: this.config.address.host, port: this.config.address.port };
    }
    const kept = this.memory.target;
    return kept ? { host: kept.host, port: kept.port } : undefined;
  }

  /** The addresses that have stops kept, one each. */
  stopAddresses() {
    const seen = new Map();
    for (const g of this.guards.values()) {
      const key = addressKey(g.target);
      if (!seen.has(key)) seen.set(key, g.target);
    }
    return [...seen.values()];
  }

  /** The stops clicked while no address was known: sent first, now that one is. */
  flushAddressless() {
    if (this.addressless.length === 0) return;
    const target = this.stopTarget();
    if (!target) return;
    const specs = this.addressless.splice(0);
    this.logger.warn(`IntelliCenter: ${specs.length} stop(s) clicked without an address sent now`);
    this.queueStop({ target, specs, received: this.mono() });
  }

  /** The same panel answers at a new address: its kept stops go there. */
  retargetStops(from, to) {
    let moved = 0;
    for (const guard of [...this.guards.values()]) {
      if (!sameAddress(guard.target, from)) continue;
      this.guards.delete(guard.key);
      guard.target = { host: to.host, port: to.port };
      guard.key = stopKey(guard.target, guard.objnam, guard.attr);
      if (!this.guards.has(guard.key)) {
        this.guards.set(guard.key, guard);
        moved += 1;
      }
    }
    if (moved > 0) {
      this.logger.warn(`IntelliCenter: ${moved} stop(s) kept follow the panel to its new address`);
      this.armStopCheck(0, to);
      this.persistStops().catch(() => {});
    }
  }

  /**
   * A stop clicked: queued before anything (it ends a read or a command on the
   * line), answered by 4.3 s after the click.
   */
  async protect(received, spec) {
    // Every command that arrived before this stop and has not left gives way.
    this.protectSeq += 1;
    for (const entry of this.commandQueue.splice(0)) {
      this.finishWith(entry, ERRORS.stopMeanwhile);
    }
    // /data holds the address of the last read: known even before the
    // configuration (a hung disk never holds the stop back: 200 ms at most).
    await this.bounded(this.loadMemory(), TIMINGS.stopSaveWait);
    const target = this.stopTarget();
    if (!target) {
      // Kept in memory: sent first as soon as an address is known.
      if (!this.addressless.some((s) => s.objnam === spec.objnam && s.attr === spec.attr)) {
        this.addressless.push(spec);
      }
      throw this.refusal(ERRORS.noAddress);
    }
    const job = this.queueStop({ target, specs: [spec], received });
    // By setting, not by address: the stop may follow the panel to a new address meanwhile.
    const key = settingKey(spec.objnam, spec.attr);
    const answerIn = Math.max(0, received + TIMINGS.commandAnswerBy - this.mono());
    let timer;
    const done = await Promise.race([
      job.done.then(() => true),
      new Promise((resolve) => {
        timer = this.timers.setTimeout(() => resolve(false), answerIn);
      }),
    ]);
    this.timers.clearTimeout(timer);
    if (!done) {
      const guard = [...this.guards.values()].find(
        (g) => g.objnam === spec.objnam && g.attr === spec.attr,
      );
      throw this.refusal(
        guard?.written ? ERRORS.stopUnconfirmed : ERRORS.stopNotSent('no turn yet'),
      );
    }
    const result = job.results.get(key);
    if (result?.error) {
      throw result.error;
    }
    return undefined;
  }

  /** Queues a stop, in the order of the clicks; a job for the same address still waiting is joined. */
  queueStop({ target, specs, received, fromBoot = false }) {
    let job = this.stops.find((j) => !j.running && sameAddress(j.target, target));
    if (job) {
      for (const spec of specs) {
        if (!job.specs.some((s) => s.objnam === spec.objnam && s.attr === spec.attr)) {
          job.specs.push(spec);
        }
      }
      // A click joining a job from /data: counted as a new click.
      job.fromBoot = job.fromBoot && fromBoot;
      return job;
    }
    job = { target, specs: [...specs], received, fromBoot, running: false, results: new Map() };
    job.done = new Promise((resolve) => {
      job.resolve = resolve;
    });
    this.stops.push(job);
    // Whatever holds the line ends when the stop asks for it (src/lane.js aborts it).
    this.runStops();
    return job;
  }

  runStops() {
    if (this.stopWorker) {
      return;
    }
    this.stopWorker = (async () => {
      try {
        while (this.stops.length > 0) {
          const job = this.stops[0];
          job.running = true;
          try {
            await this.sendStop(job);
          } catch (err) {
            this.logger.warn(`IntelliCenter: stop failed: ${err.message}`);
            this.armStopCheck(SECOND, job.target);
          }
          this.stops.shift();
          job.resolve();
        }
      } finally {
        this.stopWorker = undefined;
      }
    })();
  }

  newGuard(target, spec) {
    return {
      key: stopKey(target, spec.objnam, spec.attr),
      target: { host: target.host, port: target.port },
      objnam: spec.objnam,
      attr: spec.attr,
      value: spec.value,
      since: this.now(),
      written: false,
      sentAt: undefined,
      resends: 0,
      /** Refusals of the panel in a row (a code other than 200), and the last code. */
      refusals: 0,
      refusedCode: undefined,
      /** Never written again before this (monotonic): 15 s after a write, more after refusals. */
      nextTryAt: -Infinity,
      /** Seen applied by the last read (a late command may still undo it). */
      applied: false,
      /** A heat stop: the mode Off shown while the body still heats, since (monotonic). */
      heatingSince: undefined,
      /** ... and HTMODE could not be read (the heating state is unknown). */
      heatUnknown: false,
      /** What the last read said of it (src: decideStop). */
      decision: undefined,
      /** Until then, a command that left before the stop may still land: watched. */
      watchUntil: -Infinity,
    };
  }

  /** Whether this guard is still the one kept for its key. */
  current(guard) {
    return this.guards.get(guard.key) === guard;
  }

  /**
   * What a read says of a stop (`values`: the object read, or undefined):
   * 'done' (the panel shows it), 'watch' (shown, but a command sent shortly
   * before the stop may still land: read again), 'heating' (a heat stop: the
   * mode Off shown but the body still heats: watched, nothing written),
   * 'wait' (read too soon after the stop left), 'later' (not shown, but
   * written less than 15 s ago, or refused not long ago), 'resend' (not
   * shown, or not readable: written again, in doubt), 'hold' (written 4 times
   * without effect: held, said in the status, no more writes until a new
   * click).
   */
  decideStop(guard, values, readStartedAt) {
    guard.decision = this.decide(guard, values, readStartedAt);
    return guard.decision;
  }

  decide(guard, values, readStartedAt) {
    const mono = this.mono();
    if (values?.[guard.attr] === guard.value) {
      // A heat stop is applied only once the body no longer heats (HTMODE 0):
      // the mode Off alone may not stop a heater on every firmware.
      if (guard.attr === 'MODE' && integerOf(values.HTMODE) !== 0) {
        guard.applied = false;
        guard.heatingSince ??= mono;
        // HTMODE not readable: the heating state is unknown (said as such).
        guard.heatUnknown = integerOf(values.HTMODE) === undefined;
        return 'heating';
      }
      guard.applied = true;
      guard.heatingSince = undefined;
      return mono < guard.watchUntil ? 'watch' : 'done';
    }
    guard.applied = false;
    guard.heatingSince = undefined;
    if (!guard.written) {
      return 'resend';
    }
    if (guard.sentAt !== undefined && readStartedAt < guard.sentAt + TIMINGS.stopApplyDelay) {
      return 'wait';
    }
    if (guard.resends >= TIMINGS.stopResends) {
      return 'hold';
    }
    return mono < guard.nextTryAt ? 'later' : 'resend';
  }

  /** A stop written (bytes left): never written again before 15 s. */
  noteWritten(guard, at) {
    guard.written = true;
    guard.sentAt = at;
    guard.nextTryAt = at + TIMINGS.stopCheck;
  }

  /** The panel accepted the write (200). */
  noteAccepted(guard) {
    guard.refusals = 0;
    guard.refusedCode = undefined;
  }

  /** The panel refused the write: not applied, written again later and later (15 s .. 5 min). */
  noteRefused(guard, err) {
    guard.sentAt = undefined;
    guard.refusals += 1;
    guard.refusedCode = err?.code ?? '?';
    const wait = Math.min(TIMINGS.stopRefusedMax, TIMINGS.stopCheck * 2 ** (guard.refusals - 1));
    guard.nextTryAt = this.mono() + wait;
  }

  /** A read (poll) seen by the stops of its address: applied, or checked now when one is due. */
  observeStops(objects, startedAt, address) {
    let check = false;
    for (const guard of [...this.guards.values()]) {
      if (!sameAddress(guard.target, address)) continue;
      const decision = this.decideStop(guard, objects?.get(guard.objnam)?.values, startedAt);
      if (decision === 'done') this.dropGuard(guard, 'applied');
      else if (decision === 'resend') check = true;
    }
    if (check && !this.checking.has(addressKey(address))) this.armStopCheck(0, address);
  }

  /** The SETPARAMLIST of these stops. */
  stopWrites(guards) {
    return { objectList: this.writesOf(guards.map((g) => [g.objnam, g.attr, g.value])) };
  }

  /** The values of these objects on the line held, within `until`. */
  async readBack(target, objnams, holder, until) {
    const query = {
      objectList: [...new Set(objnams)].map((objnam) => ({ objnam, keys: COMMAND_KEYS })),
    };
    const answer = await this.client.request(target, COMMANDS.GET, query, {
      timeoutMs: Math.max(TIMINGS.commandMinRequest, until - this.mono()),
      signal: holder.signal,
    });
    const objects = parseObjects(answer, COMMAND_KEYS);
    if (!objects) throw new PanelError(ERROR_KINDS.PROTOCOL, 'No object list');
    return objects;
  }

  /**
   * One stop job (one or more settings, one address): one SETPARAMLIST without
   * a read first, on a new connection, then the read back that alone
   * confirms it. Unreachable, cut, silent: tried again every 250 ms until 3 s
   * after the click (the write is idempotent). Not confirmed: kept (in /data)
   * and checked every 15 s.
   */
  async sendStop(job) {
    const { target } = job;
    const retryUntil = Math.max(job.received, this.mono()) + TIMINGS.stopRetryFor;
    const guards = job.specs.map((spec) => {
      const key = stopKey(target, spec.objnam, spec.attr);
      let guard = this.guards.get(key);
      if (!guard) {
        guard = this.newGuard(target, spec);
        this.guards.set(key, guard);
      }
      if (!job.fromBoot) {
        // A new click: its writes are counted anew, written now.
        guard.since = this.now();
        guard.resends = 0;
        guard.refusals = 0;
        guard.nextTryAt = -Infinity;
      }
      // A command that left shortly before this click may land after it: watched.
      guard.watchUntil = Math.max(
        guard.watchUntil,
        (this.lastOnSentAt.get(spec.objnam) ?? -Infinity) + TIMINGS.stopWatchFor,
      );
      return guard;
    });
    // In /data before the first byte, so a restart sends it again; a save that
    // fails or hangs never holds the stop back (200 ms at most).
    await this.bounded(this.persistStops(), TIMINGS.stopSaveWait);
    // A restart sending a stop already written before: a resend once the panel accepts it.
    const resendOnBoot = new Set(guards.filter((g) => job.fromBoot && g.written));
    let back;
    let failure;
    let written = false;
    let sentGuards = [];
    this.logger.info(`IntelliCenter: stop of ${guards.length} setting(s)`);
    for (;;) {
      let live = guards.filter((g) => this.current(g));
      if (live.length === 0) break;
      const holder = await this.lane.acquire('stop');
      try {
        const timeoutMs = Math.max(
          TIMINGS.stopRetry,
          Math.min(TIMINGS.stopTryTimeout, retryUntil - this.mono()),
        );
        await this.client.request(target, COMMANDS.SET, () => this.stopWrites(live), {
          timeoutMs,
          signal: holder.signal,
          fresh: true,
          beforeSend: () => {
            // Let go while it waited for the line (a command of the setting
            // that left, the panel showing it): nothing to write for it.
            live = live.filter((g) => this.current(g));
            if (live.length === 0) throw new Error('nothing left to write');
            const at = this.mono();
            this.lastSentAt = at;
            written = true;
            sentGuards = live;
            for (const g of live) this.noteWritten(g, at);
          },
        });
        failure = undefined;
        for (const g of live) {
          this.noteAccepted(g);
          if (resendOnBoot.has(g)) g.resends += 1;
        }
        // Read back once the panel had time to apply it (within the ack budget).
        await this.sleep(
          Math.min(TIMINGS.applyWait, job.received + TIMINGS.commandAnswerBy - 600 - this.mono()),
        );
        try {
          back = await this.readBack(
            target,
            live.map((g) => g.objnam),
            holder,
            job.received + TIMINGS.commandAnswerBy,
          );
        } catch (err) {
          this.logger.debug(`IntelliCenter: read back of the stop failed (${errorReason(err)})`);
        }
        break;
      } catch (err) {
        failure = err;
        if (err.kind === ERROR_KINDS.REFUSED) {
          // Answered with a refusal: not applied, written again later.
          for (const g of live) this.noteRefused(g, err);
        }
      } finally {
        holder.release();
      }
      const again = [
        ERROR_KINDS.UNREACHABLE,
        ERROR_KINDS.TIMEOUT,
        ERROR_KINDS.ABORTED,
        ERROR_KINDS.CLOSED,
        ERROR_KINDS.PROTOCOL,
      ].includes(failure.kind);
      if (!again || this.mono() + TIMINGS.stopRetry >= retryUntil) break;
      await this.sleep(TIMINGS.stopRetry);
    }
    let keep = false;
    for (const guard of guards) {
      const key = settingKey(guard.objnam, guard.attr);
      if (!this.current(guard)) {
        // Let go meanwhile (a newer command left): nothing more to say.
        job.results.set(key, {});
        continue;
      }
      const decision = back
        ? this.decideStop(guard, back.get(guard.objnam)?.values, Infinity)
        : undefined;
      if (decision === 'done') {
        this.dropGuard(guard, 'applied', { quiet: true });
        job.results.set(key, {});
        continue;
      }
      keep = true;
      if (decision === 'watch') {
        job.results.set(key, {});
      } else if (decision === 'heating') {
        job.results.set(key, { error: this.refusal(ERRORS.stopStillHeating) });
      } else if (failure && !sentGuards.includes(guard)) {
        job.results.set(key, { error: this.refusal(ERRORS.stopNotSent(errorReason(failure))) });
      } else if (failure?.kind === ERROR_KINDS.REFUSED) {
        job.results.set(key, { error: this.refusal(ERRORS.stopRefused(errorReason(failure))) });
      } else if (failure) {
        job.results.set(key, { error: this.refusal(ERRORS.sentUnconfirmed(errorReason(failure))) });
      } else {
        job.results.set(key, {
          error: this.refusal(back ? ERRORS.stopNotApplied : ERRORS.stopUnconfirmed),
        });
      }
    }
    // Armed before /data is written, never awaited: a hung disk never stops
    // the checks nor holds the next click behind this one.
    if (keep) this.armStopCheck(this.nextCheckDelay(target), target);
    this.persistStops().catch(() => {});
    if (written) this.followUp();
    if (!failure && back) this.logger.info('IntelliCenter: stop sent and read back');
    this.updateStatus().catch(() => {});
  }

  /** Whether a click or a command waits or runs: a check gives way to them. */
  checkMustYield() {
    return (
      this.stops.length > 0 ||
      Boolean(this.stopWorker) ||
      Boolean(this.commandWorker) ||
      this.commandQueue.length > 0
    );
  }

  /** The delay of the next check of an address, from what its stops wait for (15 s at most). */
  nextCheckDelay(target) {
    let delay = TIMINGS.stopCheck;
    const mono = this.mono();
    for (const g of this.guards.values()) {
      if (!sameAddress(g.target, target)) continue;
      // Only what the last read said: 'watch' (read again at the end of the
      // watch), 'wait' (read too soon after the write), 'later' (written again
      // at its time); else every 15 s.
      if (g.decision === 'watch' && mono < g.watchUntil) {
        delay = Math.min(delay, Math.max(0, g.watchUntil - mono + 1));
      } else if (g.decision === 'wait' && g.sentAt !== undefined) {
        delay = Math.min(delay, Math.max(0, g.sentAt + TIMINGS.stopApplyDelay - mono));
      } else if (g.decision === 'later') {
        delay = Math.min(delay, Math.max(SECOND, g.nextTryAt - mono));
      }
    }
    return delay;
  }

  /**
   * The periodic check of the stops of one address: reads their objects, then
   * writes again only those `decideStop` says, in one SETPARAMLIST. Each
   * address has its own check and its own pace. It gives its turn up to a
   * click or a command (tried again a second later), and checks once more
   * right before its write. It arms no follow-up read.
   */
  async runCheck(target) {
    const at = addressKey(target);
    const guards = [...this.guards.values()].filter((g) => sameAddress(g.target, target));
    if (guards.length === 0) return;
    if (this.checkMustYield() || this.checking.has(at)) {
      this.armStopCheck(SECOND, target);
      return;
    }
    this.checking.add(at);
    const decisions = new Map();
    let yielded = false;
    let holder;
    try {
      // Every exit of the check ends below: let go on 'done', the next check armed, /data.
      await (async () => {
        holder = await this.lane.acquire('check');
        if (this.checkMustYield()) {
          yielded = true;
          return;
        }
        const startedAt = this.mono();
        let read;
        // A command arriving takes the line from a check (src/lane.js): a
        // check of a dead address never makes a command miss its turn.
        const wait = TIMINGS.readTimeout;
        try {
          read = await this.readBack(
            target,
            guards.map((g) => g.objnam),
            holder,
            this.mono() + wait,
          );
        } catch (err) {
          if (err.kind === ERROR_KINDS.ABORTED) throw err;
          // Nothing readable: written again when due, in doubt (the write is the stop).
          read = undefined;
        }
        for (const g of guards) {
          if (!this.current(g)) continue;
          decisions.set(g, this.decideStop(g, read?.get(g.objnam)?.values, startedAt));
        }
        let resend = guards.filter((g) => decisions.get(g) === 'resend');
        if (resend.length === 0) return;
        const wasWritten = new Set(resend.filter((g) => g.written));
        try {
          await this.client.request(target, COMMANDS.SET, () => this.stopWrites(resend), {
            timeoutMs: wait,
            signal: holder.signal,
            beforeSend: () => {
              if (this.checkMustYield()) {
                throw new Error('a newer click or command');
              }
              resend = resend.filter((g) => this.current(g));
              if (resend.length === 0) throw new Error('nothing left to write');
              this.logger.warn(
                `IntelliCenter: ${resend.length} stop(s) not shown by the panel: written again`,
              );
              const now = this.mono();
              this.lastSentAt = now;
              for (const g of resend) this.noteWritten(g, now);
            },
          });
        } catch (err) {
          if (err.kind === ERROR_KINDS.YIELDED) {
            yielded = true;
            return;
          }
          if (err.kind === ERROR_KINDS.REFUSED) {
            for (const g of resend) this.noteRefused(g, err);
          }
          throw err;
        }
        // Accepted by the panel: a resend (a refusal or a silence is not one).
        for (const g of resend) {
          this.noteAccepted(g);
          if (wasWritten.has(g)) g.resends += 1;
        }
        await this.sleep(TIMINGS.applyWait, holder.signal);
        try {
          const back = await this.readBack(
            target,
            resend.map((g) => g.objnam),
            holder,
            this.mono() + wait,
          );
          for (const g of resend) {
            if (!this.current(g)) continue;
            decisions.set(g, this.decideStop(g, back.get(g.objnam)?.values, Infinity));
          }
        } catch (err) {
          if (err.kind === ERROR_KINDS.ABORTED) throw err;
        }
      })();
    } catch (err) {
      if (err?.kind === ERROR_KINDS.ABORTED) {
        // Its turn taken by a stop or a command: again a second later.
        yielded = true;
      } else {
        this.logger.warn(`IntelliCenter: check of the stops failed (${errorReason(err)})`);
      }
    } finally {
      holder?.release();
      this.checking.delete(at);
    }
    for (const [g, decision] of decisions) {
      if (decision === 'done' && this.current(g)) this.dropGuard(g, 'applied', { quiet: true });
    }
    // Armed before /data is written (a hung disk never stops the checks).
    this.armStopCheck(yielded ? SECOND : this.nextCheckDelay(target), target);
    this.persistStops().catch(() => {});
    this.updateStatus().catch(() => {});
  }

  dropGuard(guard, reason, { quiet = false } = {}) {
    if (!this.current(guard)) return;
    this.guards.delete(guard.key);
    this.logger.info(`IntelliCenter: stop of ${guard.objnam} let go (${reason})`);
    const at = addressKey(guard.target);
    const check = this.checks.get(at);
    if (check && !this.stopAddresses().some((t) => addressKey(t) === at)) {
      this.timers.clearTimeout(check.timer);
      this.checks.delete(at);
    }
    if (!quiet) {
      this.persistStops().catch(() => {});
      this.updateStatus().catch(() => {});
    }
  }

  /**
   * The next check of the stops of `target` (every address with stops when
   * omitted): every 15 s, whatever the interval or the failures; a check
   * already due sooner is never pushed back.
   */
  armStopCheck(delay = TIMINGS.stopCheck, target = undefined) {
    if (!target) {
      for (const t of this.stopAddresses()) this.armStopCheck(delay, t);
      return;
    }
    if (!this.guards.size || !this.stopAddresses().some((t) => sameAddress(t, target))) return;
    const at = addressKey(target);
    const dueAt = this.mono() + delay;
    const current = this.checks.get(at);
    if (current) {
      if (current.dueAt <= dueAt) return;
      this.timers.clearTimeout(current.timer);
    }
    const check = { dueAt, timer: undefined };
    check.timer = this.timers.setTimeout(() => {
      if (this.checks.get(at) === check) this.checks.delete(at);
      this.runCheck(target).catch((err) =>
        this.logger.warn(`IntelliCenter: check: ${err.message}`),
      );
    }, delay);
    this.checks.set(at, check);
  }
}
