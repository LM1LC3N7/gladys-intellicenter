// -----------------------------------------------------------------------------
// A fake IntelliCenter panel, built from pyintellicenter 0.3.2 (its mock
// server tests/mock_server.py, its attribute tables and its controller): one
// JSON object per line ended by CR LF, `messageID` echoed, `response: "200"`,
// a key the object does not have echoed with its own name. Two ways in:
//   - `connect()`: a socket double on the virtual clock of the tests (no
//     network); latencies, silences, refusals and cuts are options;
//   - `onData` for the TCP server of gladys-testkit (the real-clock tests).
// -----------------------------------------------------------------------------

import { EventEmitter } from 'node:events';

export const HOST = '192.168.1.60';
export const PORT = 6681;
export const SNAME = 'Pentair: 12-34-56';
export const NOW = Date.UTC(2026, 6, 15, 10, 0, 0);

export function initialObjects() {
  return {
    B1101: {
      OBJTYP: 'BODY',
      SUBTYP: 'POOL',
      SNAME: 'Pool',
      STATUS: 'ON',
      TEMP: '82',
      LOTMP: '84',
      MODE: '1',
      HTMODE: '0',
    },
    B1202: {
      OBJTYP: 'BODY',
      SUBTYP: 'SPA',
      SNAME: 'Spa',
      STATUS: 'OFF',
      TEMP: '80',
      LOTMP: '100',
      MODE: '2',
      HTMODE: '0',
    },
    C0006: {
      OBJTYP: 'CIRCUIT',
      SUBTYP: 'POOL',
      SNAME: 'Pool',
      STATUS: 'ON',
      BODY: 'B1101',
      FEATR: 'OFF',
    },
    C0001: {
      OBJTYP: 'CIRCUIT',
      SUBTYP: 'SPA',
      SNAME: 'Spa',
      STATUS: 'OFF',
      BODY: 'B1202',
      FEATR: 'OFF',
    },
    C0003: {
      OBJTYP: 'CIRCUIT',
      SUBTYP: 'INTELLI',
      SNAME: 'Pool Light',
      STATUS: 'OFF',
      FEATR: 'ON',
    },
    C0004: { OBJTYP: 'CIRCUIT', SUBTYP: 'GENERIC', SNAME: 'Cleaner', STATUS: 'OFF', FEATR: 'ON' },
    C0005: { OBJTYP: 'CIRCUIT', SUBTYP: 'GENERIC', SNAME: 'Aux 5', STATUS: 'OFF', FEATR: 'OFF' },
    P0001: {
      OBJTYP: 'PUMP',
      SUBTYP: 'SPEED',
      SNAME: 'Pool Pump',
      STATUS: '10',
      RPM: '2400',
      PWR: '650',
    },
    S0001: { OBJTYP: 'SENSE', SUBTYP: 'AIR', SNAME: 'Air', SOURCE: '75' },
    H0001: { OBJTYP: 'HEATER', SUBTYP: 'GENERIC', SNAME: 'Gas Heater', BODY: 'B1101 B1202' },
    CHEM1: {
      OBJTYP: 'CHEM',
      SUBTYP: 'ICHEM',
      SNAME: 'IntelliChem',
      PHVAL: '7.4',
      ORPVAL: '690',
      PHSET: '7.5',
      ORPSET: '700',
    },
    CHL01: { OBJTYP: 'CHEM', SUBTYP: 'ICHLOR', SNAME: 'IntelliChlor', SALT: '3200' },
  };
}

/**
 * The panel. Options (all may be changed later on the object):
 * `timers` (the clock of the answers), `latencyMs` (number or (command) =>
 * number), `applyDelayMs` (a write applied that long after its answer),
 * `refuseSet` (a code answered to SETPARAMLIST), `onRequest(message)`, `ignoreSet` (answered 200,
 * never applied), `silent` / `silentSet` (no answer), `dropSet` ('before' |
 * 'after': the connection cut instead of the answer, the write applied or
 * not), `down` (connections refused), `mode` (ENGLISH | METRIC), `connectMs`
 * (the time a connection takes), `closeAfterAnswer(message)` (the connection
 * closed right after answering it).
 */
export function fakePanel(options = {}) {
  const panel = {
    timers: globalThis,
    latencyMs: 5,
    applyDelayMs: 0,
    refuseSet: undefined,
    ignoreSet: false,
    silent: false,
    silentSet: false,
    dropSet: undefined,
    down: false,
    connectMs: 1,
    closeAfterAnswer: undefined,
    hostOk: (host, port) => host === HOST && port === PORT,
    ...options,
    system: {
      PROPNAME: 'Smith Pool',
      VER: 'IC: 1.064 , ICWEB:2021-10-19 1.007',
      MODE: options.mode ?? 'ENGLISH',
      SNAME,
    },
    objects: initialObjects(),
    /** Every request: { command, message, conn }. */
    requests: [],
    connections: 0,
    open: 0,
    peak: 0,
    sockets: new Set(),
    sets() {
      return this.requests.filter((r) => r.command === 'SETPARAMLIST');
    },
    count(command) {
      return this.requests.filter((r) => r.command === command).length;
    },
  };

  const value = (params, key) => (Object.hasOwn(params, key) ? params[key] : key);

  /** The answer to one request (an object), or undefined (silent). */
  panel.handle = (message, conn) => {
    const command = message?.command;
    panel.requests.push({
      command,
      message,
      conn,
      at: panel.timers === globalThis ? performance.now() : panel.clockNow?.(),
    });
    panel.onRequest?.(message);
    if (panel.silent) return undefined;
    const id = message.messageID;
    if (command === 'GetParamList') {
      if (message.condition === 'OBJTYP=SYSTEM') {
        const keys = message.objectList?.[0]?.keys ?? [];
        const params = Object.fromEntries(keys.map((k) => [k, value(panel.system, k)]));
        return {
          command: 'SendParamList',
          messageID: id,
          response: '200',
          objectList: [{ objnam: '_5451', params }],
        };
      }
      const list = [];
      for (const req of message.objectList ?? []) {
        const keys = req.keys ?? [];
        const names = req.objnam === 'INCR' ? Object.keys(panel.objects) : [req.objnam];
        for (const objnam of names) {
          const params = panel.objects[objnam];
          if (!params) continue;
          list.push({ objnam, params: Object.fromEntries(keys.map((k) => [k, value(params, k)])) });
        }
      }
      return { command: 'SendParamList', messageID: id, response: '200', objectList: list };
    }
    if (command === 'SETPARAMLIST') {
      if (panel.silentSet === 'applied') {
        for (const entry of message.objectList ?? []) {
          if (panel.objects[entry.objnam]) Object.assign(panel.objects[entry.objnam], entry.params);
        }
        return undefined;
      }
      if (panel.silentSet) return undefined;
      if (panel.refuseSet)
        return { command: 'SETPARAMLIST', messageID: id, response: panel.refuseSet };
      const apply = () => {
        if (panel.ignoreSet) return;
        for (const entry of message.objectList ?? []) {
          const target = panel.objects[entry.objnam];
          if (target) Object.assign(target, entry.params);
        }
      };
      if (panel.dropSet === 'after') {
        apply();
        return 'drop';
      }
      if (panel.dropSet === 'before') return 'drop';
      if (panel.applyDelayMs > 0) panel.timers.setTimeout(apply, panel.applyDelayMs);
      else apply();
      return {
        command: 'SETPARAMLIST',
        messageID: id,
        response: '200',
        objectList: message.objectList,
      };
    }
    return { messageID: id, response: '400' };
  };

  const latency = (command) =>
    typeof panel.latencyMs === 'function' ? panel.latencyMs(command) : panel.latencyMs;

  /** A socket double (net.Socket events) on `panel.timers`. */
  panel.connect = ({ host, port }) => {
    const socket = new EventEmitter();
    socket.destroyed = false;
    socket.buffer = '';
    const conn = { id: panel.connections + 1, socket };
    const close = () => {
      if (socket.destroyed) return;
      socket.destroyed = true;
      panel.sockets.delete(socket);
      if (socket.opened) panel.open -= 1;
      panel.timers.setTimeout(() => !socket.emitted && socket.emit('close'), 0);
    };
    socket.destroy = close;
    socket.end = close;
    socket.write = (text) => {
      if (socket.destroyed) throw new Error('write after destroy');
      socket.buffer += text;
      let index;
      while ((index = socket.buffer.indexOf('\r\n')) !== -1) {
        const line = socket.buffer.slice(0, index);
        socket.buffer = socket.buffer.slice(index + 2);
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        const answer = panel.handle(message, conn);
        if (answer === undefined) continue;
        panel.timers.setTimeout(() => {
          if (socket.destroyed) return;
          if (answer === 'drop') {
            close();
            return;
          }
          socket.emit('data', Buffer.from(`${JSON.stringify(answer)}\r\n`));
          // The panel may close the connection right after an answer.
          if (panel.closeAfterAnswer?.(message)) {
            // The close is seen right after the answer (a FIN behind it).
            close();
            socket.emit('close');
            socket.emitted = true;
          }
        }, latency(message.command));
      }
      return true;
    };
    panel.timers.setTimeout(() => {
      if (socket.destroyed) return;
      const ok = panel.hostOk(host, port);
      // 'hang': a dead address, the connection never opens nor fails.
      if (ok === 'hang') return;
      if (panel.down || !ok) {
        socket.destroyed = true;
        socket.emit('error', new Error('ECONNREFUSED'));
        socket.emit('close');
        return;
      }
      panel.connections += 1;
      panel.open += 1;
      panel.peak = Math.max(panel.peak, panel.open);
      socket.opened = true;
      panel.sockets.add(socket);
      socket.emit('connect');
    }, panel.connectMs);
    return socket;
  };

  /** Pushes a line to every open connection (a NotifyList, garbage...). */
  panel.push = (text) => {
    for (const socket of panel.sockets) {
      if (!socket.destroyed) socket.emit('data', Buffer.from(text));
    }
  };

  /** For the TCP server of the kit: the answers to the lines of a chunk. */
  panel.onData = (chunk, conn) => {
    conn.buffer = (conn.buffer ?? '') + chunk.toString('utf8');
    let out = '';
    let index;
    while ((index = conn.buffer.indexOf('\r\n')) !== -1) {
      const line = conn.buffer.slice(0, index);
      conn.buffer = conn.buffer.slice(index + 2);
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      const answer = panel.handle(message, conn);
      if (answer === 'drop') {
        conn.destroy();
        return undefined;
      }
      if (answer !== undefined) out += `${JSON.stringify(answer)}\r\n`;
    }
    return out || undefined;
  };

  return panel;
}
