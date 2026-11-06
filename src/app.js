// -----------------------------------------------------------------------------
// The Deako Connect of the configuration (one TCP connection, src/link.js),
// its devices (lights, dimmers) as Gladys devices keyed by their uuid, the
// commands, the "Test the connection" button. index.js only wires the SDK
// handlers (src/handlers.js).
//
// States: a full read (DEVICE_LIST) when a connection opens and every poll
// interval (never sooner, the time of the attempt in /data before it), and
// the EVENT messages the Connect pushes between. Order: every message we send
// and every EVENT received takes the next `tick`; a device remembers the tick
// of its last EVENT or command (`mark`). A DEVICE_FOUND of a read applies its
// state only if the read left after that mark: a read that left before a
// command (or before a change pushed meanwhile) never applies after it.
//
// Offs (power 0, brightness 0) are protective: never refused by the queue, a
// read or a command in flight (cut once stuck 1 s), the 800 ms gap, a failed
// connection, the configuration not read (the address in /data), a device not
// listed yet. Clicked, an Off cancels the commands of that device still
// waiting, has no deadline to leave (its ack comes by 4.3 s, "in line" when
// still queued), skips the pause after dead connections on its first send
// (one connection per click, src/link.js), is tried again for 250 ms unless
// the next try is more than 1 s away, then kept (a guard, in /data):
//   - not sent, or sent without an answer (no answer, cut, DEVICE_BUSY): sent
//     again every 10 s (the probe, which also opens the connection) and as
//     soon as a connection opens, never given up;
//   - answered "ok": any EVENT of the device after that answer ends the guard
//     (off = done; on = turned on at the wall or in the app, never undone); a
//     full read that left 2 s after the answer, no EVENT since, showing on,
//     sends it again 10 s after the last send (one read is asked 5 s later);
//   - a send counts as a try only once the Connect answered it (ok or an
//     error but DEVICE_BUSY); after 4 answered tries the Off is no longer sent
//     again (the status says it; a new click starts again).
// A guard ends when an EVENT after its "ok" or a later read shows the device
// off, an EVENT after its "ok" shows it on, a newer command of the device
// left, a newer Off, or the device is deleted.
//
// Non-protective commands (on, brightness 1-100) leave in line, 800 ms apart
// (API.md 1.1), those of one device merged while waiting (a scene); the ack
// comes by 3.5 s: done (an EVENT shows the state asked), or the reason. One
// still waiting then stays in line up to 30 s (a scene of many lights: every
// light is set), and never leaves after an Off of its device.
//
// Two clocks: `now` (wall) dates /data only; `monotonic` paces everything
// else (reads, retries, deadlines, the publication budget).
// -----------------------------------------------------------------------------

import { createLogger } from '@gladysassistant/integration-sdk';
import { addressOf, normalizeConfig } from './config.js';
import { FEATURES as F, LIMITS, PRIORITY, TIMINGS, TYPES } from './constants.js';
import { buildDevice, parseExternalId, valuesOf } from './devices.js';
import { DeakoLink, LinkError } from './link.js';
import {
  controlRequest,
  deviceCount,
  listRequest,
  parseDeviceFound,
  parseEvent,
  pingRequest,
  validState,
} from './protocol.js';
import { ERRORS, T, age, both, deviceName, reasonOf, shortId, word } from './i18n.js';
import { StatePublisher } from './publisher.js';
import { emptyMemory, fileStore, normalizeMemory } from './store.js';

/** A status is cut to this length (Gladys shows one block). */
const STATUS_MAX = 900;

/** A value of Gladys as an integer; undefined when it is not one (never '' as 0). */
export function integerOf(value) {
  if (typeof value === 'number') return Number.isInteger(value) ? value : undefined;
  if (typeof value === 'string' && /^\s*-?\d{1,6}\s*$/.test(value)) return Number(value);
  return undefined;
}

/** A command of Gladys -> `{ protective: true }` | `{ target }`; undefined when invalid. */
export function commandOf(key, value) {
  if (value === undefined) return undefined;
  if (key === F.POWER) {
    if (value === 0) return { protective: true };
    if (value === 1) return { target: { power: true } };
    return undefined;
  }
  if (key === F.BRIGHTNESS) {
    if (value === 0) return { protective: true };
    if (value >= 1 && value <= 100) return { target: { power: true, dim: value } };
    return undefined;
  }
  return undefined;
}

export class App {
  constructor({
    gladys,
    logger = createLogger({ name: 'deako' }),
    connect,
    now = Date.now,
    monotonic = () => performance.now(),
    timers = globalThis,
    store = fileStore(),
    publisher,
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.connect = connect;
    this.now = now;
    this.monotonic = monotonic;
    this.timers = timers;
    this.store = store;
    this.publisher = publisher ?? new StatePublisher({ gladys, logger, now: monotonic, timers });
    this.config = normalizeConfig();
    this.configLoaded = false;
    this.configTries = 0;
    this.configTimer = undefined;
    this.configGeneration = 0;
    this.configLoading = undefined;
    this.configLoader = undefined;
    this.lastConfigAsk = -Infinity;
    this.memory = emptyMemory();
    this.memoryLoaded = false;
    this.memoryLoading = undefined;
    this.storeUnreadable = false;
    this.saveFailed = false;
    this.saving = undefined;
    this.saveTickets = 0;
    this.storeReading = undefined;
    /** The link to the Connect, and its address key. */
    this.link = undefined;
    this.linkKey = undefined;
    /** The open connection of the link (alive once the Connect answered on it). */
    this.conn = undefined;
    this.connecting = false;
    this.failures = 0;
    this.lastReason = undefined;
    this.reconnectTimer = undefined;
    this.reconnectAt = undefined;
    this.lastTestAt = -Infinity;
    this.pingTimer = undefined;
    /** Full reads. */
    this.lastListAt = undefined;
    this.listBusy = false;
    this.listing = undefined;
    this.listTimer = undefined;
    this.followTimer = undefined;
    /** id -> { id, name, dimmable, listed, state: { power, dim }, mark, stateConn }. */
    this.devices = new Map();
    this.tooMany = false;
    /** id -> guard of an Off. */
    this.guards = new Map();
    this.probeTimer = undefined;
    /** id -> the non-protective command of the device not sent yet (merged). */
    this.waiting = new Map();
    /** id -> Set of watchers of the EVENTs of the device ({ onEvent(state) }). */
    this.watchers = new Map();
    this.tick = 0;
    this.seq = 0;
    this.ready = false;
    this.readyWaiters = new Set();
    this.lifecycle = Promise.resolve();
    this.configSeq = 0;
    this.keptSent = false;
    this.lastStatus = undefined;
    this.published = undefined;
    this.stopped = false;
  }

  // --- Lifecycle -------------------------------------------------------------

  /**
   * Connected to Gladys (each time): /data read (once), the Offs it holds sent to the address
   * it holds, then the configuration read (`load`, the SDK's getConfig), read again on failure
   * (5 s, 15 s, then every minute) with a status saying so.
   */
  async onConnected(load) {
    this.configLoader = load;
    this.publisher.start();
    await this.ensureMemory();
    this.sendKept();
    this.configTries = 0;
    this.clearConfigTimer();
    await this.loadConfig();
  }

  loadConfig() {
    if (!this.configLoading) {
      this.configLoading = this.loadConfigNow().finally(() => {
        this.configLoading = undefined;
      });
    }
    return this.configLoading;
  }

  /** A command came before the configuration: read it now, or 2 s after the last read at most. */
  askConfig() {
    if (!this.configLoader || this.configLoading) return;
    const wait = Math.max(0, this.lastConfigAsk + TIMINGS.configAskGap - this.monotonic());
    this.clearConfigTimer();
    this.configTimer = this.timers.setTimeout(() => {
      this.configTimer = undefined;
      return this.loadConfig().catch(() => {});
    }, wait);
  }

  async loadConfigNow() {
    const generation = ++this.configGeneration;
    this.lastConfigAsk = this.monotonic();
    let raw;
    try {
      raw = await this.configLoader();
    } catch (err) {
      if (generation !== this.configGeneration) return;
      const wait = TIMINGS.configRetry[Math.min(this.configTries, TIMINGS.configRetry.length - 1)];
      this.configTries += 1;
      this.logger.warn(
        `deako: configuration not read (${err?.name ?? 'Error'}); new try in ${Math.round(wait / 1000)} s`,
      );
      this.clearConfigTimer();
      this.configTimer = this.timers.setTimeout(() => {
        this.configTimer = undefined;
        return this.loadConfig().catch(() => {});
      }, wait);
      // Not awaited: a slow Gladys never delays the next read of the configuration.
      this.setStatus(false, T.configNotRead(age(wait))).catch(() => {});
      return;
    }
    if (generation !== this.configGeneration) return;
    this.configTries = 0;
    await this.connected(raw);
  }

  clearConfigTimer() {
    if (this.configTimer !== undefined) {
      this.timers.clearTimeout(this.configTimer);
      this.configTimer = undefined;
    }
  }

  /** The configuration read at a connection to Gladys (a reconnection resends what Gladys forgot). */
  connected(raw = {}) {
    return this.enqueue(raw, true);
  }

  /** A configuration saved by the user. */
  configUpdated(raw = {}) {
    return this.enqueue(raw, false);
  }

  /** One configuration at a time, in order; one superseded by a newer one still waiting is skipped. */
  enqueue(raw, reconnection) {
    const seq = ++this.configSeq;
    const job = async () => {
      if (seq === this.configSeq) await this.startSession(raw);
      if (reconnection) {
        this.gladys.forgetPublishedStates?.();
        this.published = undefined;
        const status = this.lastStatus;
        this.lastStatus = undefined;
        if (status) {
          const [connected, message] = JSON.parse(status);
          await this.setStatus(connected, message ?? undefined);
        }
        await this.publishDevices();
      }
    };
    const run = this.lifecycle.then(job, job);
    this.lifecycle = run.catch((err) =>
      this.logger.error(`deako: configuration not applied (${err?.name ?? 'Error'})`),
    );
    return this.lifecycle;
  }

  /** A session: the link to the address typed (kept when it did not change). */
  async startSession(raw) {
    await this.ensureMemory();
    this.config = normalizeConfig(raw);
    this.configLoaded = true;
    if (this.config.address) {
      this.useAddress(this.config.address);
      if (this.memory.address !== this.config.address.key) {
        this.memory.address = this.config.address.key;
        this.saveSoon();
      }
    } else {
      this.dropLink();
    }
    this.setReady();
    await this.refreshStatus();
    await this.publishDevices();
    this.ensureConnection();
    this.scheduleList();
    if (this.conn) this.armPing();
  }

  setReady() {
    this.ready = true;
    for (const resolve of this.readyWaiters) resolve(true);
    this.readyWaiters.clear();
  }

  /** Resolves true once a session started, false at `deadline` (monotonic). */
  waitReady(deadline) {
    if (this.ready) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = (ok) => {
        this.timers.clearTimeout(timer);
        this.readyWaiters.delete(done);
        resolve(ok);
      };
      const timer = this.timers.setTimeout(
        () => done(false),
        Math.max(0, deadline - this.monotonic()),
      );
      this.readyWaiters.add(done);
    });
  }

  stop() {
    this.stopped = true;
    this.configGeneration += 1;
    this.clearConfigTimer();
    this.publisher.stop();
    for (const name of ['probeTimer', 'reconnectTimer', 'pingTimer', 'listTimer', 'followTimer']) {
      if (this[name] !== undefined) this.timers.clearTimeout(this[name]);
      this[name] = undefined;
    }
    // No timer left after a stop: the waits for an EVENT and for the configuration end now.
    for (const set of [...this.watchers.values()]) for (const watcher of [...set]) watcher.end();
    for (const done of [...this.readyWaiters]) done(false);
    this.dropLink();
  }

  /** The container stops: /data written (bounded), then every timer and the connection. */
  async shutdown() {
    this.configGeneration += 1;
    this.clearConfigTimer();
    await this.saveMemory();
    this.stop();
  }

  refusal(text) {
    return new Error(word(text, this.config.language));
  }

  // --- /data -------------------------------------------------------------------

  /** `{ value }` once `promise` settles within `ms`, `{ late: true }` otherwise. */
  bounded(promise, ms = TIMINGS.storeWait) {
    let timer;
    return Promise.race([
      promise.then((value) => ({ value })),
      new Promise((resolve) => {
        timer = this.timers.setTimeout(() => resolve({ late: true }), Math.max(0, ms));
      }),
    ]).finally(() => this.timers.clearTimeout(timer));
  }

  /** One read of /data at a time, waited TIMINGS.storeWait at most from its start. */
  loadStore() {
    let entry = this.storeReading;
    if (!entry) {
      let promise;
      try {
        promise = Promise.resolve(this.store.load());
      } catch (err) {
        promise = Promise.reject(err);
      }
      entry = { at: this.monotonic(), promise };
      this.storeReading = entry;
      promise
        .catch(() => {})
        .finally(() => {
          if (this.storeReading === entry) this.storeReading = undefined;
        });
    }
    const left = entry.at + TIMINGS.storeWait - this.monotonic();
    if (left <= 0) return Promise.resolve({ late: true });
    return this.bounded(entry.promise, left);
  }

  /** /data read once (bounded): unreadable is not empty, nothing is written over it. */
  ensureMemory() {
    if (this.memoryLoaded) return Promise.resolve();
    this.memoryLoading ??= (async () => {
      let loaded = null;
      try {
        const answer = await this.loadStore();
        if (answer.late) throw Object.assign(new Error('no answer'), { code: 'timeout' });
        loaded = answer.value;
        this.storeUnreadable = false;
      } catch (err) {
        this.storeUnreadable = true;
        this.logger.warn(`deako: /data unreadable (${err?.code ?? err?.name ?? 'error'})`);
      }
      this.adoptMemory(normalizeMemory(loaded, this.now()));
      this.memoryLoaded = true;
    })().finally(() => {
      this.memoryLoading = undefined;
    });
    return this.memoryLoading;
  }

  /** What /data holds, merged with what this process already knows (which wins). */
  adoptMemory(saved) {
    const kept = this.memory;
    this.memory = saved;
    if (kept.address) this.memory.address = kept.address;
    if (this.lastListAt === undefined && saved.lastListAt !== undefined) {
      this.lastListAt = this.monotonic() - (this.now() - saved.lastListAt);
    }
    for (const g of saved.guards) {
      if (!this.guards.has(g.id)) this.guards.set(g.id, this.makeGuard(g));
    }
  }

  /** /data reads again after it could not be read; true once it reads. */
  async reloadMemory() {
    let answer;
    try {
      answer = await this.loadStore();
    } catch {
      return false;
    }
    if (answer.late) return false;
    if (!this.storeUnreadable) return true;
    this.storeUnreadable = false;
    this.adoptMemory(normalizeMemory(answer.value, this.now()));
    this.logger.info('deako: /data reads again');
    this.refreshStatus().catch(() => {});
    return true;
  }

  /** The pace and the guards into the memory written to /data. */
  syncMemory() {
    const now = this.now();
    const mono = this.monotonic();
    if (this.lastListAt !== undefined) {
      this.memory.lastListAt = Math.min(now, now - (mono - this.lastListAt));
    }
    this.memory.guards = [...this.guards.values()].slice(0, LIMITS.guards).map((g) => ({
      id: g.id,
      left: g.left,
      tries: g.tries,
      ...(g.okSeen ? { accepted: true } : {}),
    }));
  }

  /** true when /data holds the state of now; bounded, one save at a time (gladys-ipx800 0.1.3). */
  async saveMemory() {
    if (!this.memoryLoaded) return false;
    if (this.storeUnreadable && !(await this.reloadMemory())) return false;
    const ticket = ++this.saveTickets;
    for (;;) {
      const entry = this.saving ?? this.startSave();
      const left = entry.at + TIMINGS.storeWait - this.monotonic();
      const answer = left <= 0 ? { late: true } : await this.bounded(entry.done, left);
      if (answer.late) {
        // A save that never ends is left behind: the next one starts anew (fileStore writes it
        // through a temporary file of its own), so /data is written again once it answers.
        if (this.saving === entry) this.saving = undefined;
        return this.storeFailed({ code: 'timeout' });
      }
      if (entry.ticket >= ticket) {
        return answer.value === true ? this.storeWritten() : this.storeFailed(answer.value);
      }
    }
  }

  startSave() {
    this.syncMemory();
    let promise;
    try {
      promise = Promise.resolve(this.store.save(this.memory));
    } catch (err) {
      promise = Promise.reject(err);
    }
    const entry = { at: this.monotonic(), ticket: this.saveTickets };
    entry.done = promise
      .then(
        () => true,
        (err) => err ?? { code: 'error' },
      )
      .finally(() => {
        if (this.saving !== entry) return;
        this.saving = undefined;
        if (this.saveTickets > entry.ticket) this.saveMemory().catch(() => {});
      });
    this.saving = entry;
    return entry;
  }

  storeWritten() {
    if (this.saveFailed) {
      this.saveFailed = false;
      this.logger.info('deako: /data written again');
      this.refreshStatus().catch(() => {});
    }
    return true;
  }

  storeFailed(err) {
    if (!this.saveFailed) {
      this.saveFailed = true;
      this.logger.warn(
        `deako: saving the state to /data failed (${err?.code ?? err?.name ?? 'error'})`,
      );
      this.refreshStatus().catch(() => {});
    }
    return false;
  }

  /** Saved without waiting (an Off never waits for the disk). */
  saveSoon() {
    this.saveMemory().catch(() => {});
  }

  // --- The link and its connection ---------------------------------------------

  /** The link to `address` ({ host, port, key }); the one to another address is closed. */
  useAddress(address) {
    if (this.link && this.linkKey === address.key) return this.link;
    this.dropLink();
    const link = new DeakoLink({
      host: address.host,
      port: address.port,
      connect: this.connect,
      monotonic: this.monotonic,
      timers: this.timers,
      logger: this.logger,
      onMessage: (message, conn) => this.onMessage(link, message, conn),
      onOpen: (conn) => this.onOpen(link, conn),
      onClose: (conn, reason) => this.onClose(link, conn, reason),
      onConnectError: (err) => this.onConnectError(link, err),
    });
    this.link = link;
    this.linkKey = address.key;
    this.failures = 0;
    this.lastReason = undefined;
    return link;
  }

  dropLink() {
    if (!this.link) return;
    const link = this.link;
    this.link = undefined;
    this.linkKey = undefined;
    this.conn = undefined;
    this.listing = undefined;
    this.listBusy = false;
    for (const entry of this.waiting.values()) entry.settle(this.refusal(ERRORS.restarting));
    this.waiting.clear();
    link.stop();
  }

  /** Opens the connection unless open, opening, or waiting for its next try. */
  ensureConnection() {
    const link = this.link;
    if (!link || this.stopped || link.isOpen || this.connecting || this.reconnectTimer) return;
    this.connecting = true;
    link
      .open()
      .catch(() => {})
      .finally(() => {
        this.connecting = false;
      });
  }

  onOpen(link, conn) {
    if (link !== this.link) return;
    this.conn = conn;
    conn.alive = false;
    this.clearReconnect();
    this.logger.info(`deako: connected to ${this.linkKey}`);
    // The Offs first: before any read.
    this.sendPendingGuards();
    // Before the configuration is read, the connection serves the Offs of /data only.
    if (!this.configLoaded) return;
    // Alive once the Connect answers: the full read when due, a ping otherwise.
    const mono = this.monotonic();
    if (this.listDueAt(mono) > mono) this.ping(conn).finally(() => this.armPing());
    else this.armPing();
    this.scheduleList();
    // A guard accepted before (another connection, a restart) is judged by a read now.
    if ([...this.guards.values()].some((g) => this.awaitingJudgement(g))) this.requestFollowUp(0);
    this.refreshStatus().catch(() => {});
  }

  onConnectError(link, err) {
    if (link !== this.link || this.stopped) return;
    // One failure per wait: the quick tries of an Off do not stretch the pause of the reads.
    if (this.reconnectTimer === undefined) this.failures += 1;
    this.lastReason = reasonOf(err);
    this.logger.warn(`deako: ${this.linkKey} not reached (${err.detail ?? err.code})`);
    this.scheduleReconnect();
    this.refreshStatus().catch(() => {});
  }

  onClose(link, conn, reason) {
    if (link !== this.link) return;
    if (this.conn === conn) this.conn = undefined;
    if (this.listing?.conn === conn) this.endListing();
    if (this.pingTimer !== undefined) this.timers.clearTimeout(this.pingTimer);
    this.pingTimer = undefined;
    if (this.stopped) return;
    if (reason !== 'cut') {
      if (!conn.alive) this.failures += 1;
      this.lastReason = conn.reason ?? both('connection closed', 'connexion fermée');
      this.logger.warn(`deako: connection to ${this.linkKey} closed (${reason})`);
    }
    // A cut reopens at once for the request waiting; otherwise a new try after a pause.
    this.scheduleReconnect();
    this.armProbe();
    this.refreshStatus().catch(() => {});
  }

  /** The Connect answered on this connection: it is alive. */
  markAlive(conn, { answered = false } = {}) {
    if (!conn || conn.closed) return;
    if (answered && !conn.answered) {
      conn.answered = true;
      // The Connect answers our requests again (not only pushes EVENTs): the Offs held
      // unanswered go now, without their 10 s spacing.
      this.sendPendingGuards({ now: true });
    }
    if (conn.alive) return;
    conn.alive = true;
    this.failures = 0;
    this.lastReason = undefined;
    this.refreshStatus().catch(() => {});
  }

  scheduleReconnect() {
    if (this.reconnectTimer !== undefined || this.stopped || !this.link) return;
    const steps = TIMINGS.backoff;
    const wait = steps[Math.min(this.failures, steps.length - 1)];
    this.reconnectAt = this.monotonic() + wait;
    this.reconnectTimer = this.timers.setTimeout(() => {
      this.reconnectTimer = undefined;
      this.reconnectAt = undefined;
      // An Off held due: the probe (every 10 s) opens the connection for it; one opening here
      // too would double the tries on a Connect that closes at once (its slot taken).
      const mono = this.monotonic();
      if ([...this.guards.values()].some((g) => this.due(g, mono))) {
        this.scheduleReconnect();
        return;
      }
      this.ensureConnection();
    }, wait);
  }

  clearReconnect() {
    if (this.reconnectTimer !== undefined) this.timers.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.reconnectAt = undefined;
  }

  /** A ping when nothing came for TIMINGS.pingEvery; no answer closes the connection. */
  armPing() {
    if (this.pingTimer !== undefined) this.timers.clearTimeout(this.pingTimer);
    this.pingTimer = undefined;
    const conn = this.conn;
    if (!conn || this.stopped) return;
    const wait = Math.max(0, conn.lastByteAt + TIMINGS.pingEvery - this.monotonic());
    this.pingTimer = this.timers.setTimeout(() => {
      this.pingTimer = undefined;
      if (this.conn !== conn || conn.closed) return;
      if (this.link.busy) {
        // A request in flight: checked again a second later (never a loop of empty timers).
        this.pingTimer = this.timers.setTimeout(() => {
          this.pingTimer = undefined;
          this.armPing();
        }, 1000);
        return;
      }
      if (this.monotonic() - conn.lastByteAt < TIMINGS.pingEvery) {
        this.armPing();
        return;
      }
      this.ping(conn).finally(() => this.armPing());
    }, wait);
  }

  /** A ping on `conn`; resolves true when answered. No answer: the connection is closed. */
  async ping(conn) {
    const link = this.link;
    try {
      await link.request(pingRequest(), { priority: PRIORITY.READ });
      this.markAlive(conn, { answered: true });
      return true;
    } catch (err) {
      if (err instanceof LinkError && err.code === 'timeout' && this.conn === conn) {
        conn.reason = both('no answer to a ping', 'pas de réponse à un ping');
        link.close('closed');
      }
      return false;
    }
  }

  // --- Full reads (DEVICE_LIST) ----------------------------------------------------

  get interval() {
    return this.config.pollInterval * 1000;
  }

  /** The monotonic time from which the next read may start. */
  listDueAt(mono) {
    return this.lastListAt === undefined ? mono : this.lastListAt + this.interval;
  }

  scheduleList() {
    if (this.listTimer !== undefined) this.timers.clearTimeout(this.listTimer);
    this.listTimer = undefined;
    if (!this.conn || this.stopped) return;
    const mono = this.monotonic();
    const wait = Math.max(0, this.listDueAt(mono) - mono);
    this.listTimer = this.timers.setTimeout(() => {
      this.listTimer = undefined;
      this.listNow();
    }, wait);
  }

  /**
   * A full read now (one at a time, never two lists streaming at once). The time of the attempt
   * goes to /data before it (a restart never reads sooner).
   */
  listNow() {
    const conn = this.conn;
    const link = this.link;
    if (!conn || !link || this.listBusy || this.stopped || !this.configLoaded) return undefined;
    this.listBusy = true;
    const mono = this.monotonic();
    this.lastListAt = mono;
    this.saveSoon();
    let tick;
    let sentAt;
    const done = link
      .request(listRequest(), {
        priority: PRIORITY.READ,
        onSent: (at) => {
          tick = ++this.tick;
          sentAt = at;
        },
        onAnswer: (message) => {
          // Synchronous: the DEVICE_FOUND lines right behind belong to this read.
          const count = deviceCount(message.data);
          const expected = Math.min(count ?? 0, LIMITS.devices);
          this.tooMany = (count ?? 0) > LIMITS.devices;
          this.listing = {
            conn,
            tick,
            sentAt,
            expected,
            received: new Set(),
            /** DEVICE_FOUND messages of this list, unreadable ones included (its end). */
            count: 0,
            timer: undefined,
          };
          if (expected === 0) {
            this.endListing();
            return;
          }
          const wait = Math.min(
            TIMINGS.listBase + TIMINGS.listPerDevice * expected,
            TIMINGS.listMax,
          );
          const listing = this.listing;
          listing.timer = this.timers.setTimeout(() => {
            if (this.listing === listing) this.endListing();
          }, wait);
        },
      })
      .then(() => this.markAlive(conn, { answered: true }))
      .catch((err) => {
        if (!this.listing || this.listing.conn !== conn) this.listBusy = false;
        if (err instanceof LinkError && err.code === 'timeout' && this.conn === conn) {
          conn.reason = both(
            'no answer to the list of devices',
            'pas de réponse à la liste des appareils',
          );
          link.close('closed');
        }
        this.logger.warn(`deako: list of devices not read (${err?.code ?? err?.name ?? 'error'})`);
      })
      .finally(() => this.scheduleList());
    return done;
  }

  endListing() {
    const listing = this.listing;
    this.listing = undefined;
    this.listBusy = false;
    if (listing?.timer !== undefined) this.timers.clearTimeout(listing.timer);
    // A complete list: the devices it no longer has leave the Discover list.
    if (listing && !this.tooMany && listing.received.size === listing.expected) {
      for (const device of this.devices.values()) {
        if (device.listed && !listing.received.has(device.id)) device.listed = false;
      }
    }
    this.publishDevices().catch(() => {});
    this.refreshStatus().catch(() => {});
    this.flush().catch(() => {});
    this.scheduleList();
  }

  /** A full read soon, whatever the interval (after a command not seen applied, an Off to judge). */
  requestFollowUp(delay = TIMINGS.followUp) {
    if (this.followTimer !== undefined || this.stopped) return;
    this.followTimer = this.timers.setTimeout(() => {
      this.followTimer = undefined;
      if (this.listBusy) {
        // A read is streaming: the follow-up waits for its end.
        this.requestFollowUp(TIMINGS.listBase);
        return;
      }
      this.listNow();
    }, delay);
  }

  // --- Messages of the Connect -----------------------------------------------------

  onMessage(link, message, conn) {
    if (link !== this.link || conn !== this.conn) return;
    if (message.type === TYPES.DEVICE_FOUND) this.onFound(conn, message.data);
    else if (message.type === TYPES.EVENT) this.onEvent(conn, message.data);
  }

  /**
   * The entry of a device, made when needed (LIMITS.devices at most). A device listed by the
   * Connect takes the place of one only seen in an EVENT (never listed, no Off held): uuids
   * pushed by a faulty or hostile peer never keep the real devices out.
   */
  deviceOf(id, { listed = false } = {}) {
    let device = this.devices.get(id);
    if (!device) {
      if (this.devices.size >= LIMITS.devices) {
        const spare = listed
          ? [...this.devices.values()].find((d) => !d.listed && !this.guards.has(d.id))
          : undefined;
        if (!spare) {
          if (listed) this.tooMany = true;
          return undefined;
        }
        this.devices.delete(spare.id);
      }
      device = {
        id,
        name: undefined,
        dimmable: false,
        listed: false,
        state: { power: undefined, dim: undefined },
        mark: 0,
        stateConn: undefined,
      };
      this.devices.set(id, device);
    }
    return device;
  }

  onFound(conn, data) {
    const listing = this.listing;
    // Outside a read of ours (or of an older connection): not ours to apply.
    if (!listing) return;
    listing.count += 1;
    const found = parseDeviceFound(data);
    // A second DEVICE_FOUND of one device in a list: the first one stands.
    if (!found || listing.received.has(found.id)) {
      if (listing.count >= listing.expected) this.endListing();
      return;
    }
    listing.received.add(found.id);
    const device = this.deviceOf(found.id, { listed: true });
    if (device) {
      this.markAlive(conn);
      device.name = found.name ?? device.name;
      device.dimmable = found.dimmable;
      device.listed = true;
      // Only a read that left after the last command / EVENT of the device applies.
      if (listing.tick > device.mark) {
        if (found.state.power !== undefined) device.state.power = found.state.power;
        if (found.state.dim !== undefined) device.state.dim = found.state.dim;
        device.stateConn = conn;
        this.queueStates(device);
        this.judgeGuard(device, found.state.power, listing);
      }
    }
    if (listing.count >= listing.expected) this.endListing();
  }

  onEvent(conn, data) {
    const event = parseEvent(data);
    if (!event) return;
    const device = this.deviceOf(event.id);
    if (!device) return;
    this.markAlive(conn);
    device.mark = ++this.tick;
    device.state.power = event.state.power;
    // Dimmers do not always send `dim` (pydeako): the last one stays.
    if (event.state.dim !== undefined) device.state.dim = event.state.dim;
    if (event.state.dim !== undefined && !device.listed) device.dimmable = true;
    device.stateConn = conn;
    this.queueStates(device);
    this.flush().catch(() => {});
    for (const watcher of [...(this.watchers.get(event.id) ?? [])]) watcher.onEvent(event.state);
    this.judgeGuard(device, event.state.power, undefined);
  }

  /** Watches the EVENTs of `id` until `until` (monotonic); `test(state)` true ends it. */
  watch(id, until, test) {
    return new Promise((resolve) => {
      const set = this.watchers.get(id) ?? new Set();
      this.watchers.set(id, set);
      let last;
      const end = (result) => {
        this.timers.clearTimeout(timer);
        set.delete(watcher);
        if (set.size === 0 && this.watchers.get(id) === set) this.watchers.delete(id);
        resolve(result);
      };
      const watcher = {
        onEvent: (state) => {
          last = state;
          if (test(state)) end({ done: true, last });
        },
        /** At stop: no timer left. */
        end: () => end({ done: false, last }),
      };
      set.add(watcher);
      const timer = this.timers.setTimeout(
        () => end({ done: false, last }),
        Math.max(0, until - this.monotonic()),
      );
    });
  }

  // --- Guards (the Offs held) ------------------------------------------------------

  makeGuard({ id, left = false, tries = 0, accepted = false, seq = 0, inFlight = false }) {
    return {
      id,
      seq,
      /** Clicked after this tick: a read judges it only if it left after. */
      tick: ++this.tick,
      left,
      tries,
      okSeen: accepted,
      okAt: accepted ? -Infinity : undefined,
      unanswered: false,
      contradicted: false,
      // Accepted before a restart: its last send counts as now (sent again 10 s later at the earliest).
      sentAt: accepted ? this.monotonic() : -Infinity,
      sentTick: 0,
      /** Reads asked to judge it since its last "ok" (3 at most). */
      checks: 0,
      inFlight,
      userInFlight: inFlight,
      lastError: undefined,
    };
  }

  /** May be sent again: fewer than 4 answered tries. */
  canSend(guard) {
    return guard.tries <= TIMINGS.resendMax;
  }

  /** Accepted by the Connect, not judged yet (neither seen off nor contradicted). */
  awaitingJudgement(guard) {
    return guard.okSeen && !guard.contradicted && !guard.inFlight && guard.checks < 3;
  }

  /** Due for a send: never answered "ok" (pending), or contradicted 10 s after its last send. */
  due(guard, mono) {
    if (guard.inFlight || guard.userInFlight || !this.canSend(guard)) return false;
    // Never sent: at once. Sent without an answer (no answer, cut, busy): 10 s after that send
    // at the earliest, whatever opens a connection meanwhile (a little early for the probe).
    if (!guard.okSeen) return !guard.left || mono - guard.sentAt >= TIMINGS.guardProbe * 0.9;
    return guard.contradicted && mono - guard.sentAt >= TIMINGS.guardProbe;
  }

  /**
   * An observation of the device: `power` from an EVENT (`listing` undefined) or a full read.
   * Off: the guard ends. On: contradicts an Off answered "ok" (an EVENT after that answer, or a
   * read that left 2 s after it).
   */
  judgeGuard(device, power, listing) {
    const guard = this.guards.get(device.id);
    if (!guard || guard.inFlight || power === undefined) return;
    if (listing && !(listing.tick > guard.tick)) return;
    if (power === false) {
      this.guards.delete(device.id);
      this.logger.info(`deako: Off of ${shortId(device.id)} seen applied`);
      this.saveSoon();
      this.refreshStatus().catch(() => {});
      return;
    }
    if (!listing) {
      // An EVENT "on" (the guard not in flight: after its "ok", or with no send of it waiting
      // for an answer): turned on at the wall or in the app after the Off, which is never
      // undone; the guard ends (every such EVENT ends it, on or off).
      this.guards.delete(device.id);
      this.logger.info(`deako: ${shortId(device.id)} turned on elsewhere, Off no longer held`);
      this.saveSoon();
      this.refreshStatus().catch(() => {});
      return;
    }
    // On in a read, an Off not answered yet: sent by the probe anyway.
    if (!guard.okSeen) return;
    // A read that left 2 s after the "ok", no EVENT since (an EVENT would have ended the guard),
    // still showing on: the Off was not applied.
    if (!(listing.sentAt >= guard.okAt + TIMINGS.listSettle)) return;
    if (!guard.contradicted) {
      guard.contradicted = true;
      this.saveSoon();
      this.refreshStatus().catch(() => {});
    }
    this.armProbe();
  }

  armProbe() {
    if (this.probeTimer !== undefined || this.stopped) return;
    const watched = [...this.guards.values()].some(
      (g) => (this.canSend(g) && (!g.okSeen || g.contradicted)) || this.awaitingJudgement(g),
    );
    if (!watched) return;
    this.probeTimer = this.timers.setTimeout(() => {
      this.probeTimer = undefined;
      this.probe();
    }, TIMINGS.guardProbe);
  }

  /** Every 10 s: the Offs due are sent (a connection opened for them); those accepted are judged by a read. */
  probe() {
    const mono = this.monotonic();
    let judge = false;
    for (const guard of this.guards.values()) {
      if (this.due(guard, mono)) {
        this.sendGuard(guard).catch(() => {});
      } else if (this.awaitingJudgement(guard) && this.conn) {
        guard.checks += 1;
        judge = true;
      }
    }
    if (judge && this.conn) this.requestFollowUp(0);
    this.armProbe();
  }

  /** At start (once): the Offs of /data not accepted yet, before the configuration and any read. */
  sendKept() {
    if (this.keptSent) return;
    this.keptSent = true;
    if (this.guards.size === 0) return;
    if (!this.link) {
      const address = addressOf(this.memory.address);
      if (!address) return;
      this.useAddress(address);
    }
    this.sendPendingGuards();
    this.armProbe();
  }

  /** The Offs never answered "ok" (or contradicted and due): sent now, before any read. */
  sendPendingGuards({ now = false } = {}) {
    const mono = this.monotonic();
    for (const guard of this.guards.values()) {
      const pending =
        now && !guard.okSeen && !guard.inFlight && !guard.userInFlight && this.canSend(guard);
      if (pending || this.due(guard, mono)) this.sendGuard(guard).catch(() => {});
    }
  }

  /**
   * Sends the Off of `guard` (power false), protective. Resolves with the "ok" answer; rejects
   * with the LinkError (`sent` tells whether it left). A send counts as a try only once the
   * Connect answered it (ok, or an error but DEVICE_BUSY). `hurry`: the first send of a click,
   * whose connection skips the pause after dead connections (src/link.js).
   */
  sendGuard(guard, { hurry = false } = {}) {
    const link = this.link;
    if (!link) return Promise.reject(new LinkError('network', { detail: 'no address' }));
    // One send of a guard at a time.
    if (guard.inFlight)
      return Promise.reject(new LinkError('late', { detail: 'already in flight' }));
    guard.inFlight = true;
    const { id } = guard;
    const message = controlRequest(id, { power: false });
    const background = !guard.userInFlight;
    return link
      .request(message, {
        priority: PRIORITY.PROTECTIVE,
        // No deadline to leave: an Off waits for its turn however long the line (a scene of many
        // Offs); only its answer is awaited TIMINGS.commandTimeout once it left.
        deadline: Infinity,
        timeout: TIMINGS.commandTimeout,
        hurry,
        beforeSend: () => {
          // A newer click on this device took its place: nothing leaves after it.
          if (this.guards.get(id) !== guard) throw new LinkError('late', { detail: 'superseded' });
        },
        onSent: () => {
          guard.left = true;
          guard.okSeen = false;
          guard.contradicted = false;
          guard.unanswered = false;
          guard.checks = 0;
          guard.sentAt = this.monotonic();
          guard.sentTick = ++this.tick;
          // Known or not yet listed: a read that left before never applies after.
          const device = this.deviceOf(id);
          if (device) device.mark = guard.sentTick;
        },
        onAnswer: () => {
          guard.okSeen = true;
          guard.okAt = this.monotonic();
          guard.tries += 1;
        },
      })
      .then((answer) => {
        this.markAlive(this.conn, { answered: true });
        if (background) this.requestFollowUp();
        return answer;
      })
      .catch((err) => {
        guard.lastError = err;
        if (err instanceof LinkError && err.sent) {
          if (err.code === 'refused') guard.tries += 1;
          // No answer, cut, busy: no try; sent again by the probe.
          else guard.unanswered = true;
        }
        if (background) {
          this.logger.warn(`deako: Off of ${shortId(id)} not done (${err?.code ?? 'error'})`);
        }
        throw err;
      })
      .finally(() => {
        guard.inFlight = false;
        this.saveSoon();
        this.armProbe();
        this.refreshStatus().catch(() => {});
      });
  }

  // --- Commands --------------------------------------------------------------------

  /** A command from Gladys. */
  async setValue(device, feature, value) {
    // The deadlines count from the arrival of the command, before any wait.
    const received = this.monotonic();
    const parsed = parseExternalId(feature?.external_id, this.gladys.selector);
    if (!parsed?.key) throw this.refusal(ERRORS.notCommandable);
    const command = commandOf(parsed.key, integerOf(value));
    if (!command) throw this.refusal(ERRORS.badValue);
    if (command.protective) return this.protective(parsed.id, received);
    return this.command(parsed.id, command.target, received);
  }

  /**
   * An Off: no queue, read, command in flight, gap, pause nor configuration stops it (the
   * address known). It cancels the commands of the device waiting, is tried again for 250 ms,
   * and stays as a guard (in /data) until a read or an EVENT shows the device off.
   */
  async protective(id, received) {
    this.cancelCommands(id);
    if (!this.link) {
      // The address known (typed, or kept in /data): at once; the configuration is awaited
      // only when no address is known at all.
      let address = this.config.address ?? addressOf(this.memory.address);
      if (!address && !this.configLoaded) {
        this.askConfig();
        await this.waitReady(received + TIMINGS.configWait);
        address = this.config.address;
      }
      if (address) this.useAddress(address);
    }
    if (!this.link) throw this.refusal(ERRORS.addressUnknown);
    this.seq += 1;
    const guard = this.makeGuard({ id, seq: this.seq, inFlight: false });
    guard.userInFlight = true;
    this.guards.set(id, guard);
    // Written to /data without waiting: an Off never waits for the disk.
    this.saveSoon();
    this.logger.info(`deako: Off of ${shortId(id)}`);
    const answerBy = received + TIMINGS.commandAck + 800;
    const first = this.monotonic();
    let lastError;
    let queued = false;
    for (let attempt = 0; ; attempt += 1) {
      // Only the first send of the click skips the pause after dead connections: one immediate
      // connection per click.
      const sent = this.sendGuard(guard, { hurry: attempt === 0 }).then(
        () => ({}),
        (error) => ({ error }),
      );
      let timer;
      const outcome = await Promise.race([
        sent,
        new Promise((resolve) => {
          timer = this.timers.setTimeout(
            () => resolve({ late: true }),
            Math.max(0, answerBy - this.monotonic()),
          );
        }),
      ]);
      this.timers.clearTimeout(timer);
      if (outcome.late) {
        // Still in line (or its answer awaited): it goes on, the ack is given now.
        queued = true;
        break;
      }
      lastError = outcome.error;
      if (!lastError) break;
      const mono = this.monotonic();
      if (
        !(lastError instanceof LinkError) ||
        lastError.sent ||
        this.guards.get(id) !== guard ||
        mono - first >= TIMINGS.protectiveRetry ||
        this.stopped ||
        // The Connect not reached for a while: the next try waits more than 1 s (pause after dead
        // connections, up to 10 s); kept now, never "in line" for that pause.
        this.link?.reopenWait(mono) > TIMINGS.reopenFirst
      ) {
        break;
      }
      await new Promise((resolve) => this.timers.setTimeout(resolve, TIMINGS.protectiveRetryGap));
      if (this.guards.get(id) !== guard) break;
    }
    guard.userInFlight = false;
    this.saveSoon();
    if (queued) {
      this.armProbe();
      this.refreshStatus().catch(() => {});
      throw this.refusal(guard.left ? ERRORS.offUnconfirmed : ERRORS.offQueued);
    }
    if (!guard.left) {
      if (this.guards.get(id) !== guard) throw this.refusal(ERRORS.cancelledByStop);
      // Never abandoned: kept, sent every 10 s and as soon as a connection opens.
      this.armProbe();
      this.ensureConnection();
      this.refreshStatus().catch(() => {});
      throw this.refusal(ERRORS.protectiveKept(reasonOf(lastError)));
    }
    if (lastError) {
      this.armProbe();
      this.refreshStatus().catch(() => {});
      if (lastError instanceof LinkError && ['busy', 'refused'].includes(lastError.code)) {
        throw this.refusal(ERRORS.offRefused(reasonOf(lastError)));
      }
      throw this.refusal(ERRORS.offUnconfirmed);
    }
    // Answered "ok": an EVENT of the device after that answer tells.
    const seen = await this.watch(id, answerBy, (state) => state.power === false);
    if (seen.done) return undefined;
    this.requestFollowUp();
    this.armProbe();
    this.refreshStatus().catch(() => {});
    // On after the "ok": turned on again at the wall or in the app; the Off is no longer held.
    throw this.refusal(seen.last?.power === true ? ERRORS.offOverridden : ERRORS.offUnconfirmed);
  }

  /** The commands of `id` not sent yet: dropped (an Off of the device was clicked). */
  cancelCommands(id) {
    const entry = this.waiting.get(id);
    if (!entry) return;
    this.waiting.delete(id);
    this.link?.cancel(
      (job) => job.message === entry.message,
      () => this.refusal(ERRORS.cancelledByStop),
    );
    entry.settle(this.refusal(ERRORS.cancelledByStop));
  }

  /** A non-protective command (on, brightness 1-100): in line, merged with the one of the device waiting. */
  async command(id, target, received) {
    if (!this.ready) {
      if (!this.configLoaded) this.askConfig();
      if (!(await this.waitReady(received + TIMINGS.configWait))) {
        throw this.refusal(ERRORS.configNotLoaded);
      }
    }
    const link = this.link;
    if (!link) throw this.refusal(ERRORS.addressUnknown);
    if (this.guards.get(id)?.userInFlight) throw this.refusal(ERRORS.stopPending);
    const known = this.devices.get(id);
    if (target.dim !== undefined && known?.listed && !known.dimmable) {
      throw this.refusal(ERRORS.notDimmable);
    }
    let entry = this.waiting.get(id);
    if (entry) {
      // Merged: the power asked last, the brightness asked last (a scene).
      entry.target = { power: target.power, dim: target.dim ?? entry.target.dim };
      entry.message.data.state = { ...entry.target };
      if (entry.target.dim === undefined) delete entry.message.data.state.dim;
      entry.seq = this.seq;
    } else {
      if (this.waiting.size >= LIMITS.commandQueue) throw this.refusal(ERRORS.queueFull);
      entry = this.makeEntry(link, id, target, received);
    }
    const ahead = link.queue.length + (link.busy ? 1 : 0);
    let timer;
    const result = await Promise.race([
      entry.done,
      new Promise((resolve) => {
        timer = this.timers.setTimeout(
          () => resolve({ pending: true }),
          Math.max(0, received + TIMINGS.commandAck - this.monotonic()),
        );
      }),
    ]);
    this.timers.clearTimeout(timer);
    if (result.pending) {
      if (!entry.sent) throw this.refusal(ERRORS.queued(ahead));
      throw this.refusal(entry.lastState ? ERRORS.notApplied : ERRORS.unconfirmed);
    }
    if (result.error) throw result.error;
    return undefined;
  }

  makeEntry(link, id, target, received) {
    let settle;
    const entry = {
      id,
      target: { ...target },
      seq: this.seq,
      received,
      sent: false,
      message: controlRequest(id, target),
      done: new Promise((resolve) => {
        settle = resolve;
      }),
      settled: false,
    };
    entry.settle = (error) => {
      if (entry.settled) return;
      entry.settled = true;
      settle(error ? { error } : {});
    };
    this.waiting.set(id, entry);
    let restored;
    link
      .request(entry.message, {
        priority: PRIORITY.COMMAND,
        tag: id,
        deadline: received + TIMINGS.commandMaxAge,
        timeout: TIMINGS.commandTimeout,
        // A click: its connection skips the pause after dead connections (src/link.js).
        hurry: true,
        beforeSend: () => {
          // (An Off of the device clicked meanwhile removed this request from the line: see
          // cancelCommands; a request older than 30 s is dropped by the line, unsent.)
          if (this.link !== link || this.stopped) throw this.refusal(ERRORS.restarting);
          // The value written, bounded right before it leaves (merged commands included).
          if (!validState(entry.target)) throw this.refusal(ERRORS.badValue);
        },
        onSent: () => {
          entry.sent = true;
          if (this.waiting.get(id) === entry) this.waiting.delete(id);
          // Known or not yet listed: a read that left before never applies after.
          const device = this.deviceOf(id);
          if (device) device.mark = ++this.tick;
          // A newer command of the device left: the Off held for it ends here.
          const guard = this.guards.get(id);
          if (guard) {
            restored = guard;
            this.guards.delete(id);
            this.saveSoon();
          }
        },
        onAnswer: () => {
          // Synchronous: the EVENT right behind the "ok" is watched.
          entry.watching = this.watch(id, this.monotonic() + TIMINGS.commandAck, (state) => {
            entry.lastState = state;
            return (
              state.power === entry.target.power &&
              (entry.target.dim === undefined || state.dim === entry.target.dim)
            );
          });
        },
      })
      .then(async () => {
        this.markAlive(this.conn, { answered: true });
        const seen = await entry.watching;
        if (seen.done) {
          entry.settle();
          return;
        }
        this.requestFollowUp();
        entry.settle(this.refusal(seen.last ? ERRORS.notApplied : ERRORS.unconfirmed));
      })
      .catch((err) => {
        if (this.waiting.get(id) === entry) this.waiting.delete(id);
        if (!(err instanceof LinkError)) {
          entry.settle(err);
          return;
        }
        if (!err.sent) {
          entry.settle(
            this.refusal(err.code === 'late' ? ERRORS.tooOld : ERRORS.notSent(reasonOf(err))),
          );
          return;
        }
        if (['busy', 'refused'].includes(err.code)) {
          // Refused by the Connect: not a newer command, the Off stands.
          if (restored && !this.guards.has(id)) {
            this.guards.set(id, restored);
            this.saveSoon();
            this.armProbe();
          }
          entry.settle(this.refusal(ERRORS.rejected(reasonOf(err))));
          return;
        }
        this.requestFollowUp();
        entry.settle(this.refusal(ERRORS.unconfirmed));
      });
    return entry;
  }

  // --- Gladys --------------------------------------------------------------------

  createdDevices() {
    return (this.gladys.devices ?? []).filter((d) =>
      parseExternalId(d?.external_id, this.gladys.selector),
    );
  }

  createdOf(id) {
    const deviceId = this.gladys.externalIds('light', id).device;
    return this.createdDevices().find((d) => d.external_id === deviceId);
  }

  /** The states of a device, for the features its Gladys device has. */
  queueStates(device) {
    const created = this.createdOf(device.id);
    if (!created) return;
    const ids = this.gladys.externalIds('light', device.id);
    const have = new Set((created.features ?? []).map((f) => f.external_id));
    for (const [key, value] of valuesOf(device)) {
      const featureId = ids.feature(key);
      if (have.has(featureId)) this.publisher.push(featureId, { state: value });
    }
  }

  async flush() {
    await this.publisher
      .flush()
      .catch((err) => this.logger.warn(`Sending to Gladys failed: ${err.message}`));
  }

  /** The Discover list: the devices listed by the Connect. */
  async publishDevices() {
    const devices = [];
    for (const device of this.devices.values()) {
      if (!device.listed) continue;
      devices.push(
        buildDevice(this.gladys, device, {
          language: this.config.language,
          created: this.createdOf(device.id),
        }),
      );
    }
    const json = JSON.stringify(devices);
    if (json === this.published) return;
    this.published = json;
    try {
      await this.gladys.publishDiscoveredDevices(devices);
    } catch (err) {
      this.published = undefined;
      this.logger.warn(`Publishing the discovered devices failed: ${err.message}`);
    }
  }

  /** Created or updated: its state published only when fresh (kept by the EVENTs of the open connection). */
  async deviceCreated(device) {
    const parsed = parseExternalId(device?.external_id, this.gladys.selector);
    if (!parsed) return;
    this.gladys.forgetPublishedStates?.(device.external_id);
    this.published = undefined;
    const known = this.devices.get(parsed.id);
    if (known && known.stateConn && known.stateConn === this.conn && !this.conn.closed) {
      this.queueStates(known);
      this.flush().catch(() => {});
    }
    await this.publishDevices();
    await this.refreshStatus();
  }

  /** Deleted: its Off held is dropped (no device to drive any more). */
  async deviceDeleted(device) {
    const parsed = parseExternalId(device?.external_id, this.gladys.selector);
    if (!parsed) return;
    this.publisher.forget(device.external_id);
    if (this.guards.delete(parsed.id)) this.saveSoon();
    this.published = undefined;
    await this.publishDevices();
    await this.refreshStatus();
  }

  /** Discover: the list read now if due (never sooner than the interval), then published. */
  async scan() {
    this.ensureConnection();
    if (this.conn && !this.listBusy) {
      const mono = this.monotonic();
      if (this.listDueAt(mono) <= mono) this.listNow();
    }
    const until = this.monotonic() + TIMINGS.readTimeout * 2;
    while ((this.listBusy || this.connecting) && this.monotonic() < until && !this.stopped) {
      await new Promise((resolve) => this.timers.setTimeout(resolve, 100));
    }
    this.published = undefined;
    await this.publishDevices();
  }

  // --- Status --------------------------------------------------------------------

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) return;
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${err.message}`));
  }

  nameOf(id) {
    const created = this.createdOf(id);
    return created?.name ?? deviceName(this.devices.get(id) ?? { id }, this.config.language);
  }

  async refreshStatus() {
    if (!this.configLoaded) return;
    const parts = [];
    let connected = false;
    const address = this.config.address?.key;
    const listed = [...this.devices.values()].filter((d) => d.listed);
    if (!this.config.address) {
      parts.push(this.config.addressError ? T.addressError : T.noAddress);
    } else if (this.conn && this.conn.alive && !this.conn.closed) {
      connected = true;
      parts.push(listed.length > 0 ? T.connected(address, listed.length) : T.notListed(address));
    } else if (this.lastReason) {
      const wait = this.reconnectAt === undefined ? 0 : this.reconnectAt - this.monotonic();
      parts.push(T.unreachable(address, this.lastReason, age(Math.max(0, wait))));
    } else {
      parts.push(T.connecting(address));
    }
    if (this.tooMany) parts.push(T.tooMany(LIMITS.devices));
    const toAdd = listed.filter((d) => !this.createdOf(d.id)).length;
    if (toAdd > 0) parts.push(T.toAdd(toAdd));
    for (const guard of this.guards.values()) {
      const name = this.nameOf(guard.id);
      if (!this.link) parts.push(T.guardNoAddress(name));
      else if (!this.canSend(guard)) parts.push(T.guardExhausted(name));
      else if (!guard.okSeen) parts.push(T.guardPending(name));
      else parts.push(T.guardWaiting(name, guard.tries));
    }
    if (this.storeUnreadable) parts.push(T.storeUnreadable);
    else if (this.saveFailed) parts.push(T.storeProblem);
    const cut = (text) => (text.length > STATUS_MAX ? `${text.slice(0, STATUS_MAX - 1)}…` : text);
    const message = both(
      cut(parts.map((p) => p.en).join(' ')),
      cut(parts.map((p) => p.fr).join(' ')),
    );
    await this.setStatus(connected, message);
  }

  // --- Configuration button -------------------------------------------------------

  /** "Test the connection": a ping on the connection (opened now if closed, 10 s apart at most). */
  async testConnection() {
    const started = this.monotonic();
    if (!this.configLoaded) {
      this.askConfig();
      await this.waitReady(started + TIMINGS.configWait);
    }
    const lang = this.config.language;
    const address = this.config.address?.key;
    if (!address || !this.link) return word(T.test.none, lang);
    if (!this.link.isOpen) {
      const mono = this.monotonic();
      const left = this.lastTestAt + TIMINGS.testCooldown - mono;
      if (left > 0) return word(T.test.cooldown(address, age(left)), lang);
      this.lastTestAt = mono;
      this.clearReconnect();
      try {
        // A click: the pause after dead connections does not apply (10 s apart at most).
        await this.link.open(started + TIMINGS.testBudget, { hurry: true });
      } catch (err) {
        return word(T.test.failed(address, reasonOf(err)), lang);
      }
    }
    const conn = this.conn;
    const ok = await this.ping(conn);
    await this.refreshStatus();
    if (!ok)
      return word(
        T.test.failed(address, both('no answer to a ping', 'pas de réponse à un ping')),
        lang,
      );
    const listed = [...this.devices.values()].filter((d) => d.listed).length;
    return word(T.test.ok(address, listed), lang);
  }
}
