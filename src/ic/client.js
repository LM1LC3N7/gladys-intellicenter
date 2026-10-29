// -----------------------------------------------------------------------------
// The only network access: ONE TCP connection to the panel at a time, ONE
// request in flight on it (the lane of src/lane.js gives the turns; this
// client refuses a second request anyway). A request is one JSON line ended by
// CR LF; its answer is the line carrying the same `messageID`. Lines that are
// not that answer (a `NotifyList`, an answer to someone else) are skipped,
// within a bound.
//
// Bounds: a line never longer than 1 MiB (checked as bytes arrive, before the
// line is complete), a request never longer than its timeout, the connection
// closed when anything is wrong (a timeout, a line too long, an abort), and a
// new connection is only opened once the old one is closed (its 'close').
// Nothing received is ever merged into an object: the answer is JSON.parse'd
// and its fields read by name only (src/ic/model.js).
// -----------------------------------------------------------------------------

import { connect as netConnect } from 'node:net';
import { LIMITS, TIMINGS } from '../constants.js';

export const ERROR_KINDS = {
  /** No connection (refused, no route, DNS). */
  UNREACHABLE: 'unreachable',
  /** No answer in time. */
  TIMEOUT: 'timeout',
  /** The connection was closed by the panel (or broke) while waiting. */
  CLOSED: 'closed',
  /** Not the protocol (a line too long, too many lines that are not the answer). */
  PROTOCOL: 'protocol',
  /** The panel answered with a code other than "200". */
  REFUSED: 'refused',
  /** The turn was taken (a stop), or the configuration changed. */
  ABORTED: 'aborted',
  /** `beforeSend` refused (an option turned off, a stop, too late): nothing left. */
  YIELDED: 'yielded',
  /** Too late to start. */
  LATE: 'late',
};

export class PanelError extends Error {
  constructor(kind, message, extra = {}) {
    super(message);
    this.name = 'PanelError';
    this.kind = kind;
    /** Whether the request (or part of it) may have reached the panel. */
    this.sent = false;
    Object.assign(this, extra);
  }
}

/** A short reason for a status or a log, never the content of an answer. */
export function errorReason(err) {
  if (err instanceof PanelError) {
    return err.kind === ERROR_KINDS.REFUSED ? `refused (${err.code})` : err.kind;
  }
  return 'error';
}

/** A code of the panel as shown: three digits, else "?". */
const codeOf = (value) =>
  typeof value === 'string' && /^\d{3}$/.test(value)
    ? value
    : Number.isInteger(value) && value >= 100 && value <= 999
      ? String(value)
      : '?';

const CRLF = Buffer.from('\r\n');

export class PanelClient {
  /**
   * `connect({ host, port })` returns a socket (net.Socket or a test double:
   * events 'connect', 'data', 'error', 'close'; `write`, `destroy`).
   */
  constructor({
    connect = (o) => netConnect(o),
    timers = globalThis,
    now = () => performance.now(),
  } = {}) {
    this.connect = connect;
    this.timers = timers;
    this.now = now;
    this.conn = undefined;
    this.seq = 0;
    this.busy = false;
    this.idleTimer = undefined;
  }

  /** Closes the connection, if any; resolves once it is closed. */
  close() {
    this.clearIdle();
    const conn = this.conn;
    if (!conn) {
      return Promise.resolve();
    }
    this.shut(conn, true);
    return conn.closed;
  }

  /**
   * Closes a connection. `graceful`: a FIN first, so the panel closes its side
   * before a new connection opens (its 'close' comes once both sides are
   * closed), destroyed if that takes longer than 300 ms; else destroyed at once.
   */
  shut(conn, graceful) {
    if (conn.closing) return;
    conn.closing = true;
    if (!graceful || typeof conn.socket.end !== 'function') {
      conn.socket.destroy();
      return;
    }
    const timer = this.timers.setTimeout(() => conn.socket.destroy(), TIMINGS.gracefulClose);
    conn.closed.then(() => this.timers.clearTimeout(timer));
    conn.socket.end();
  }

  clearIdle() {
    if (this.idleTimer) {
      this.timers.clearTimeout(this.idleTimer);
      this.idleTimer = undefined;
    }
  }

  /** Opens a connection to `address` (after the old one is closed). */
  async open(address, { timeoutMs, signal }) {
    await this.close();
    if (signal?.aborted) {
      throw new PanelError(ERROR_KINDS.ABORTED, 'Aborted');
    }
    let socket;
    try {
      socket = this.connect({ host: address.host, port: address.port });
    } catch {
      throw new PanelError(ERROR_KINDS.UNREACHABLE, 'Cannot connect');
    }
    const conn = {
      socket,
      address: { host: address.host, port: address.port },
      chunks: [],
      size: 0,
      waiter: undefined,
      broken: undefined,
      closing: false,
      connected: false,
    };
    conn.closed = new Promise((resolve) => {
      socket.once('close', () => {
        conn.closing = true;
        if (this.conn === conn) {
          this.conn = undefined;
        }
        if (!conn.broken) conn.broken = new PanelError(ERROR_KINDS.CLOSED, 'Connection closed');
        conn.waiter?.fail(conn.broken);
        resolve();
      });
    });
    socket.on('error', () => {});
    socket.on('data', (data) => this.received(conn, data));
    this.conn = conn;
    await new Promise((resolve, reject) => {
      let settled = false;
      const done = (err) => {
        if (settled) return;
        settled = true;
        this.timers.clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        socket.off('connect', onConnect);
        if (err) {
          conn.broken = err;
          reject(err);
        } else {
          conn.connected = true;
          resolve();
        }
      };
      const onConnect = () => done();
      const onAbort = () => done(new PanelError(ERROR_KINDS.ABORTED, 'Aborted'));
      const timer = this.timers.setTimeout(
        () => done(new PanelError(ERROR_KINDS.TIMEOUT, 'Connection timed out')),
        Math.max(1, Math.min(TIMINGS.connectTimeout, timeoutMs)),
      );
      socket.once('connect', onConnect);
      conn.closed.then(() => done(new PanelError(ERROR_KINDS.UNREACHABLE, 'Cannot connect')));
      signal?.addEventListener('abort', onAbort, { once: true });
    }).catch(async (err) => {
      await this.close();
      throw err;
    });
    return conn;
  }

  /** Bytes received: split in lines, each handed to the request waiting (if any). */
  received(conn, data) {
    if (conn.closing) return;
    let start = 0;
    let index = data.indexOf(CRLF);
    // A CR at the end of the previous chunk and a LF at the start of this one.
    if (conn.size > 0 && data[0] === 0x0a && conn.chunks.at(-1).at(-1) === 0x0d) {
      const line = Buffer.concat(conn.chunks).subarray(0, conn.size - 1);
      conn.chunks = [];
      conn.size = 0;
      this.line(conn, line);
      start = 1;
      index = data.indexOf(CRLF, 1);
    }
    while (index !== -1 && !conn.closing) {
      const part = data.subarray(start, index);
      if (conn.size + part.length > LIMITS.maxLineBytes) {
        this.fail(conn, new PanelError(ERROR_KINDS.PROTOCOL, 'Line too long'));
        return;
      }
      const line = conn.size > 0 ? Buffer.concat([...conn.chunks, part]) : part;
      conn.chunks = [];
      conn.size = 0;
      this.line(conn, line);
      start = index + 2;
      index = data.indexOf(CRLF, start);
    }
    if (conn.closing || start >= data.length) return;
    const rest = data.subarray(start);
    // Checked as the bytes arrive: a line that never ends is cut at 1 MiB.
    if (conn.size + rest.length > LIMITS.maxLineBytes) {
      this.fail(conn, new PanelError(ERROR_KINDS.PROTOCOL, 'Line too long'));
      return;
    }
    conn.chunks.push(Buffer.from(rest));
    conn.size += rest.length;
  }

  /** One complete line. */
  line(conn, bytes) {
    const waiter = conn.waiter;
    if (!waiter) {
      return;
    }
    let message;
    try {
      message = JSON.parse(bytes.toString('utf8'));
    } catch {
      message = undefined;
    }
    if (
      message &&
      typeof message === 'object' &&
      !Array.isArray(message) &&
      Object.hasOwn(message, 'response') &&
      message.messageID === waiter.id
    ) {
      waiter.done(message);
      return;
    }
    waiter.others += 1;
    if (waiter.others > LIMITS.maxOtherLines) {
      this.fail(conn, new PanelError(ERROR_KINDS.PROTOCOL, 'No answer among the lines'));
    }
  }

  fail(conn, err) {
    if (!conn.broken) conn.broken = err;
    conn.waiter?.fail(err);
    if (!conn.closing) {
      conn.closing = true;
      conn.socket.destroy();
    }
  }

  /**
   * One request. `fields`: an object, or a function called right after
   * `beforeSend` (its result is what is written). `beforeSend()` runs right
   * before the first byte, after the connection is open: when it throws,
   * nothing is written (a YIELDED error carrying it as `cause`). `fresh`: a
   * new connection even when one is open. Resolves the answer (response
   * "200"); rejects a PanelError whose `sent` says if the bytes left.
   */
  async request(address, command, fields, { timeoutMs, signal, beforeSend, fresh = false } = {}) {
    if (this.busy) {
      throw new PanelError(ERROR_KINDS.PROTOCOL, 'A request is already in flight');
    }
    if (signal?.aborted) {
      throw new PanelError(ERROR_KINDS.ABORTED, 'Aborted');
    }
    this.busy = true;
    this.clearIdle();
    const started = this.now();
    const left = () => Math.max(1, timeoutMs - (this.now() - started));
    try {
      let conn = this.conn;
      if (
        fresh ||
        !conn ||
        conn.closing ||
        conn.broken ||
        conn.address.host !== address.host ||
        conn.address.port !== address.port
      ) {
        conn = await this.open(address, { timeoutMs, signal });
      }
      if (beforeSend) {
        try {
          beforeSend();
        } catch (cause) {
          throw new PanelError(ERROR_KINDS.YIELDED, 'Not sent', { cause });
        }
      }
      if (signal?.aborted) {
        throw new PanelError(ERROR_KINDS.ABORTED, 'Aborted');
      }
      this.seq = (this.seq % 1_000_000) + 1;
      const id = `gladys-${this.seq}`;
      const body = typeof fields === 'function' ? fields() : fields;
      const text = `${JSON.stringify({ messageID: id, command, ...body })}\r\n`;
      return await this.exchange(conn, id, text, { timeoutMs: left(), signal });
    } finally {
      this.busy = false;
      this.armIdle();
    }
  }

  /** Writes the request, waits for its answer. */
  exchange(conn, id, text, { timeoutMs, signal }) {
    return new Promise((resolve, reject) => {
      let timer;
      const end = () => {
        this.timers.clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        if (conn.waiter === waiter) conn.waiter = undefined;
      };
      const waiter = {
        id,
        others: 0,
        done: (message) => {
          end();
          if (message.response === '200') {
            resolve(message);
            return;
          }
          const err = new PanelError(ERROR_KINDS.REFUSED, 'Refused', {
            code: codeOf(message.response),
          });
          err.sent = true;
          reject(err);
        },
        fail: (err) => {
          end();
          const failure = new PanelError(err.kind, err.message, { code: err.code });
          failure.sent = true;
          // The connection ends with the failure; the caller waits for its close.
          conn.closed.then(() => reject(failure));
          this.shut(conn, err.kind === ERROR_KINDS.ABORTED);
        },
      };
      const onAbort = () => waiter.fail(new PanelError(ERROR_KINDS.ABORTED, 'Aborted'));
      if (conn.broken || conn.closing) {
        const err = new PanelError(
          conn.broken?.kind ?? ERROR_KINDS.CLOSED,
          conn.broken?.message ?? 'Connection closed',
        );
        conn.closed.then(() => reject(err));
        return;
      }
      conn.waiter = waiter;
      timer = this.timers.setTimeout(
        () => waiter.fail(new PanelError(ERROR_KINDS.TIMEOUT, 'No answer')),
        Math.max(1, timeoutMs),
      );
      signal?.addEventListener('abort', onAbort, { once: true });
      try {
        conn.socket.write(text);
      } catch {
        waiter.fail(new PanelError(ERROR_KINDS.CLOSED, 'Write failed'));
      }
    });
  }

  /** The connection is closed once idle (a new one at the next request). */
  armIdle() {
    this.clearIdle();
    if (!this.conn) return;
    this.idleTimer = this.timers.setTimeout(() => {
      this.idleTimer = undefined;
      if (!this.busy) this.close();
    }, TIMINGS.idleClose);
  }
}
