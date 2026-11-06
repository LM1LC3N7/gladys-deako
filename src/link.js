// -----------------------------------------------------------------------------
// The TCP connection to the Deako Connect: one connection at a time, one
// request in flight at a time (no pipeline), by priority (Off, command, read),
// 800 ms between two non-protective messages (API.md 1.1; an Off never waits
// for it).
//
// - A request is answered by the message carrying its `transactionId`; its
//   `onAnswer` runs synchronously, before the next line of the same chunk is
//   read (an EVENT right behind the "ok" of a CONTROL is after it).
// - A request in flight with no byte received for TIMINGS.stuck is cut when a
//   request of a higher priority waits (an Off behind a command or a read, a
//   command behind a read) or an Off waits behind a silent Off: the connection
//   is destroyed, then a new one is opened for the waiting request (never two
//   connections at once). A cut is "left, without answer", never "not sent".
// - Only an Off or a command opens a connection; a read or a ping waiting
//   fails when there is none (the app opens connections, with its pauses).
// - Lines are LIMITS.lineBytes at most: a longer one closes the connection.
// - `beforeSend` runs right before the first byte of a request, on an open
//   connection; it may throw (nothing sent). `onSent` runs once it is written.
// Every wait is bounded (connect, answer, gap); the timers are injected.
// -----------------------------------------------------------------------------

import { createConnection } from 'node:net';
import { LIMITS, PRIORITY, TIMINGS, DEVICE_ERRORS } from './constants.js';
import { errorCode, lineOf, lineReader, parseLine } from './protocol.js';

/** A closed connection is waited for this long at most before the next one. */
const CLOSE_WAIT = 200;

export class LinkError extends Error {
  /**
   * code: network (no connection), timeout (no answer), cut, closed, late (not sent in
   * time, or refused by beforeSend), busy (DEVICE_BUSY), refused (another error answer),
   * stopped. `sent`: the request left (fully written to the connection).
   */
  constructor(code, { sent = false, detail, deviceCode } = {}) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = 'LinkError';
    this.code = code;
    this.sent = sent;
    this.detail = detail;
    this.deviceCode = deviceCode;
  }
}

/** The default socket: a plain TCP connection, Nagle off (small lines). */
export function tcpConnect({ host, port }) {
  const socket = createConnection({ host, port });
  socket.setNoDelay?.(true);
  return socket;
}

export class DeakoLink {
  constructor({
    host,
    port,
    connect = tcpConnect,
    monotonic = () => performance.now(),
    timers = globalThis,
    logger,
    onMessage = () => {},
    onOpen = () => {},
    onClose = () => {},
    onConnectError = () => {},
  }) {
    this.host = host;
    this.port = port;
    this.connectFn = connect;
    this.monotonic = monotonic;
    this.timers = timers;
    this.logger = logger;
    this.onMessage = onMessage;
    this.onOpen = onOpen;
    this.onClose = onClose;
    this.onConnectError = onConnectError;
    /** The open connection: { id, socket, reader, closed, lastByteAt }. */
    this.conn = undefined;
    this.opening = undefined;
    this.closing = undefined;
    this.connSeq = 0;
    this.queue = [];
    this.inFlight = undefined;
    this.lastSendAt = -Infinity;
    this.gapTimer = undefined;
    this.cutTimer = undefined;
    this.pumping = false;
    this.again = false;
    this.seq = 0;
    this.stopped = false;
  }

  get isOpen() {
    return this.conn !== undefined && !this.conn.closed;
  }

  // --- Connection ------------------------------------------------------------

  /** Opens the connection (shared), bounded by TIMINGS.connectTimeout and `deadline`. */
  open(deadline = Infinity) {
    if (this.stopped) return Promise.reject(new LinkError('stopped'));
    if (this.isOpen) return Promise.resolve(this.conn);
    if (!this.opening) {
      this.opening = this.connectNow().finally(() => {
        this.opening = undefined;
      });
    }
    const left = deadline - this.monotonic();
    if (left <= 0) return Promise.reject(new LinkError('late', { detail: 'no time left' }));
    if (left >= TIMINGS.connectTimeout) return this.opening;
    let timer;
    return Promise.race([
      this.opening,
      new Promise((_, reject) => {
        timer = this.timers.setTimeout(
          () => reject(new LinkError('late', { detail: 'no time left to connect' })),
          left,
        );
      }),
    ]).finally(() => this.timers.clearTimeout(timer));
  }

  /** The old connection closed first (its 'close' seen, 200 ms at most), then a new one. */
  async connectNow() {
    if (this.closing) await this.closing;
    if (this.stopped) throw new LinkError('stopped');
    return this.connectSocket();
  }

  connectSocket() {
    return new Promise((resolve, reject) => {
      let socket;
      let timer;
      let done = false;
      const fail = (err) => {
        if (done) return;
        done = true;
        this.timers.clearTimeout(timer);
        try {
          socket?.destroy();
        } catch {
          // already gone
        }
        try {
          this.onConnectError(err);
        } catch {
          // the app's own problem
        }
        reject(err);
      };
      try {
        socket = this.connectFn({ host: this.host, port: this.port });
      } catch (err) {
        fail(new LinkError('network', { detail: err?.code ?? 'error' }));
        return;
      }
      // An 'error' after the first one (or after destroy) never crashes the process.
      socket.on('error', () => {});
      timer = this.timers.setTimeout(
        () => fail(new LinkError('network', { detail: 'connect timeout' })),
        TIMINGS.connectTimeout,
      );
      socket.once('error', (err) =>
        fail(new LinkError('network', { detail: err?.code ?? 'error' })),
      );
      socket.once('connect', () => {
        if (done) return;
        done = true;
        this.timers.clearTimeout(timer);
        if (this.stopped) {
          socket.destroy();
          reject(new LinkError('stopped'));
          return;
        }
        const conn = {
          id: ++this.connSeq,
          socket,
          reader: lineReader(LIMITS.lineBytes),
          closed: false,
          lastByteAt: this.monotonic(),
        };
        this.conn = conn;
        socket.on('error', () => this.drop(conn, 'closed'));
        socket.on('data', (chunk) => this.onData(conn, chunk));
        socket.on('end', () => this.drop(conn, 'closed'));
        socket.on('close', () => {
          conn.socketClosed = true;
          this.drop(conn, 'closed');
        });
        try {
          this.onOpen(conn);
        } catch (err) {
          this.logger?.warn?.(`deako: open handler failed (${err?.name ?? 'Error'})`);
        }
        resolve(conn);
      });
    });
  }

  /** Closes `conn` (the current one only): the request in flight on it ends as cut / closed. */
  drop(conn, reason) {
    if (!conn || conn.closed) return;
    conn.closed = true;
    if (this.conn === conn) this.conn = undefined;
    // The next connection waits for this one to be closed (a Connect may serve one client).
    const closing = new Promise((resolve) => {
      if (conn.socketClosed) {
        resolve();
        return;
      }
      const timer = this.timers.setTimeout(resolve, CLOSE_WAIT);
      conn.socket.once?.('close', () => {
        this.timers.clearTimeout(timer);
        resolve();
      });
    }).finally(() => {
      if (this.closing === closing) this.closing = undefined;
    });
    this.closing = closing;
    try {
      conn.socket.destroy();
    } catch {
      // already gone
    }
    // The reads and pings waiting end with the connection (never a reason to open another).
    this.cancel(
      (j) => j.priority === PRIORITY.READ,
      () => new LinkError('closed', { detail: 'connection closed' }),
    );
    const job = this.inFlight;
    if (job && job.conn === conn) {
      this.finish(job, null, new LinkError(reason === 'cut' ? 'cut' : 'closed', { sent: true }));
    }
    this.clearCut();
    try {
      this.onClose(conn, reason);
    } catch (err) {
      this.logger?.warn?.(`deako: close handler failed (${err?.name ?? 'Error'})`);
    }
    this.pump();
  }

  /** Closes the current connection (a ping without answer, a stop). */
  close(reason = 'closed') {
    this.drop(this.conn, reason);
  }

  onData(conn, chunk) {
    if (conn.closed) return;
    conn.lastByteAt = this.monotonic();
    let lines;
    try {
      lines = conn.reader.push(chunk);
    } catch {
      this.logger?.warn?.('deako: a message over 16 KB, connection closed');
      this.drop(conn, 'size');
      return;
    }
    for (const line of lines) {
      if (conn.closed) return;
      const message = parseLine(line);
      if (!message) continue;
      this.handle(conn, message);
    }
    if (!conn.closed) this.armCut();
  }

  handle(conn, message) {
    const job = this.inFlight;
    if (
      job &&
      job.conn === conn &&
      typeof message.transactionId === 'string' &&
      message.transactionId === job.message.transactionId
    ) {
      if (message.status === 'ok') {
        try {
          job.onAnswer?.(message);
        } catch (err) {
          this.logger?.warn?.(`deako: answer handler failed (${err?.name ?? 'Error'})`);
        }
        this.finish(job, message);
      } else {
        const deviceCode = errorCode(message);
        this.finish(
          job,
          null,
          new LinkError(deviceCode === DEVICE_ERRORS.BUSY ? 'busy' : 'refused', {
            sent: true,
            deviceCode,
            detail: deviceCode ?? String(message.status ?? 'error').slice(0, 20),
          }),
        );
      }
      return;
    }
    try {
      this.onMessage(message, conn);
    } catch (err) {
      this.logger?.warn?.(`deako: message not handled (${err?.name ?? 'Error'})`);
    }
  }

  // --- Requests --------------------------------------------------------------

  /**
   * Queues `message`; resolves with the "ok" answer. Options: priority, deadline (monotonic:
   * not sent after it, not awaited after it), timeout (the answer), beforeSend, onSent(at),
   * onAnswer(message) (synchronous), tag (for cancel).
   */
  request(
    message,
    { priority = PRIORITY.READ, deadline, timeout, beforeSend, onSent, onAnswer, tag } = {},
  ) {
    if (this.stopped) return Promise.reject(new LinkError('stopped'));
    return new Promise((resolve, reject) => {
      const job = {
        message,
        priority,
        deadline: deadline ?? this.monotonic() + TIMINGS.readTimeout + TIMINGS.connectTimeout,
        timeout: timeout ?? TIMINGS.readTimeout,
        beforeSend,
        onSent,
        onAnswer,
        tag,
        seq: ++this.seq,
        resolve,
        reject,
        conn: undefined,
        timer: undefined,
        sentAt: undefined,
      };
      // By priority, then in order of arrival.
      const at = this.queue.findIndex((j) => j.priority < priority);
      if (at === -1) this.queue.push(job);
      else this.queue.splice(at, 0, job);
      this.pump();
      this.armCut();
    });
  }

  /** Removes the queued (not sent) requests for which `match(job)` is true; each rejected with `error`. */
  cancel(match, error) {
    for (const job of [...this.queue]) {
      if (match(job)) {
        this.queue.splice(this.queue.indexOf(job), 1);
        job.reject(typeof error === 'function' ? error(job) : error);
      }
    }
  }

  get busy() {
    return this.inFlight !== undefined;
  }

  finish(job, answer, error) {
    if (this.inFlight !== job) return;
    this.inFlight = undefined;
    this.timers.clearTimeout(job.timer);
    this.clearCut();
    if (error) job.reject(error);
    else job.resolve(answer);
    this.pump();
  }

  pump() {
    if (this.stopped) return;
    if (this.pumping) {
      // Served right after the pass in progress (an Off queued meanwhile never waits a gap).
      this.again = true;
      return;
    }
    this.pumping = true;
    this.again = false;
    this.pumpNow()
      .catch((err) => this.logger?.warn?.(`deako: line error (${err?.name ?? 'Error'})`))
      .finally(() => {
        this.pumping = false;
        if (this.again && !this.stopped) this.pump();
      });
  }

  async pumpNow() {
    while (!this.inFlight && this.queue.length > 0 && !this.stopped) {
      const job = this.queue[0];
      const mono = this.monotonic();
      if (mono >= job.deadline) {
        this.queue.shift();
        job.reject(new LinkError('late', { detail: 'not sent in time' }));
        continue;
      }
      if (job.priority < PRIORITY.PROTECTIVE) {
        const due = this.lastSendAt + TIMINGS.sendGap;
        if (due > mono) {
          this.waitGap(due - mono);
          return;
        }
      }
      if (!this.isOpen) {
        if (job.priority === PRIORITY.READ) {
          // A read or a ping never opens a connection: the app opens them, with its pauses.
          this.queue.shift();
          job.reject(new LinkError('network', { detail: 'not connected' }));
          continue;
        }
        try {
          await this.open(job.deadline);
        } catch (err) {
          // Nothing left: the requests waiting fail now (none was sent); the app decides when to
          // connect again.
          const failed = err instanceof LinkError ? err : new LinkError('network');
          for (const j of this.queue.splice(0)) j.reject(failed);
          return;
        }
        continue;
      }
      this.queue.shift();
      try {
        job.beforeSend?.();
      } catch (err) {
        job.reject(err);
        continue;
      }
      const conn = this.conn;
      const at = this.monotonic();
      try {
        conn.socket.write(lineOf(job.message));
      } catch {
        job.reject(new LinkError('closed', { detail: 'write failed' }));
        this.drop(conn, 'closed');
        continue;
      }
      job.conn = conn;
      job.sentAt = at;
      this.lastSendAt = at;
      this.inFlight = job;
      try {
        job.onSent?.(at);
      } catch (err) {
        this.logger?.warn?.(`deako: sent handler failed (${err?.name ?? 'Error'})`);
      }
      const wait = Math.max(0, Math.min(job.timeout, job.deadline - at));
      job.timer = this.timers.setTimeout(() => {
        this.finish(job, null, new LinkError('timeout', { sent: true }));
      }, wait);
      this.armCut();
    }
  }

  waitGap(ms) {
    if (this.gapTimer !== undefined) return;
    this.gapTimer = this.timers.setTimeout(() => {
      this.gapTimer = undefined;
      this.pump();
    }, ms);
  }

  /** A request of a higher priority waits behind one in flight: cut it once stuck. */
  armCut() {
    this.clearCut();
    const job = this.inFlight;
    // A more urgent request waits, or another Off behind a silent Off.
    const urgent = (j) =>
      j.priority > job.priority ||
      (j.priority === PRIORITY.PROTECTIVE && job.priority === PRIORITY.PROTECTIVE);
    if (!job || !this.queue.some(urgent)) return;
    const conn = job.conn;
    const quietSince = Math.max(job.sentAt, conn.lastByteAt);
    const wait = Math.max(0, quietSince + TIMINGS.stuck - this.monotonic());
    this.cutTimer = this.timers.setTimeout(() => {
      this.cutTimer = undefined;
      // Armed again at every chunk received (onData): firing means 1 s without a byte.
      if (this.inFlight !== job || conn.closed) return;
      this.logger?.info?.('deako: a request without answer cut for a more urgent one');
      this.drop(conn, 'cut');
    }, wait);
  }

  clearCut() {
    if (this.cutTimer !== undefined) {
      this.timers.clearTimeout(this.cutTimer);
      this.cutTimer = undefined;
    }
  }

  stop() {
    this.stopped = true;
    this.timers.clearTimeout(this.gapTimer);
    this.gapTimer = undefined;
    this.clearCut();
    for (const job of this.queue.splice(0)) job.reject(new LinkError('stopped'));
    const job = this.inFlight;
    if (job) {
      this.inFlight = undefined;
      this.timers.clearTimeout(job.timer);
      job.reject(new LinkError('stopped', { sent: true }));
    }
    if (this.conn) {
      const conn = this.conn;
      conn.closed = true;
      this.conn = undefined;
      try {
        conn.socket.destroy();
      } catch {
        // already gone
      }
    }
  }
}
