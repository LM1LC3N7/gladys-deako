// -----------------------------------------------------------------------------
// Constants: the local API of the Deako Connect, the feature keys, the limits
// and the timings.
//
// API (Deako "local-integrations" API.md 1.5, 2020, and pydeako 0.6.0, both
// MIT, by Deako): a TCP connection to port 23 of the Deako Connect (or of a
// Deako switch acting as the bridge), single-line JSON messages separated by
// CRLF, each request with a `transactionId` (uuid v4) answered by a message
// carrying the same id and `status` "ok" | "error":
//   - `DEVICE_LIST`: answered with `number_of_devices`, then one unsolicited
//     `DEVICE_FOUND` per device (`name`, `uuid`, `capabilities` "power" |
//     "power+dim", `state` { power, dim 0-100 });
//   - `CONTROL` { target, state { power, dim? } }: answered "ok" (being
//     processed), then an unsolicited `EVENT` (`DEVICE_STATE_CHANGE`) shows
//     the new state; errors DEVICE_BUSY, DEVICE_UNKNOWN, REQUEST_*;
//   - `PING`: answered `PING` "ok";
//   - `EVENT` `DEVICE_STATE_CHANGE` { target, state }: any change (the wall
//     switch, the app, a command).
// "Do not send messages faster than 800 ms apart" (API.md 1.1).
// -----------------------------------------------------------------------------

export const API = {
  defaultPort: 23,
  /** Our `src` in the messages (the Connect answers to it in `dst`). */
  source: 'Gladys',
  destination: 'deako',
};

export const TYPES = {
  DEVICE_LIST: 'DEVICE_LIST',
  DEVICE_FOUND: 'DEVICE_FOUND',
  EVENT: 'EVENT',
  CONTROL: 'CONTROL',
  PING: 'PING',
};

export const DEVICE_ERRORS = {
  BUSY: 'DEVICE_BUSY',
  UNKNOWN: 'DEVICE_UNKNOWN',
};

/** What the API accepts for `dim` (API.md 3.6). */
export const DIM = { min: 0, max: 100 };

/** Feature keys (the last part of the feature external ids): frozen. */
export const FEATURES = {
  /** light/binary: 0 = off, 1 = on. */
  POWER: 'power',
  /** light/brightness 0-100 % (dimmers only): 0 = off. */
  BRIGHTNESS: 'brightness',
};

export const ACTIONS = {
  TEST_CONNECTION: 'test_connection',
};

/** The interval of the full reads (DEVICE_LIST), in seconds: changes come as events between. */
export const POLL_INTERVAL = { min: 30, max: 3600, default: 60 };

export const LIMITS = {
  /** Devices of one Connect (a profile); more are ignored, said in the status. */
  devices: 128,
  /** Gladys: 300 states per minute; a margin is kept. */
  statesPerMinute: 250,
  statesPerRequest: 100,
  /** One message (a line) at most; a longer one closes the connection (a message is ~300 bytes). */
  lineBytes: 16 * 1024,
  /** Names are cut to this length. */
  nameLength: 60,
  /** An uuid (or any id) of a device at most. */
  idLength: 64,
  /** Non-protective commands waiting (a scene). */
  commandQueue: 64,
  /** Offs kept in /data. */
  guards: 128,
};

export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;

/** Priorities of the line (one request in flight at a time). */
export const PRIORITY = { PROTECTIVE: 3, COMMAND: 2, READ: 1 };

export const TIMINGS = {
  /** A TCP connection is opened within this, or it failed. */
  connectTimeout: 2 * SECOND,
  /** The answer (`status`) of a read or a ping is awaited this long. */
  readTimeout: 3 * SECOND,
  /** The answer of a command is awaited this long at most (and never past its deadline). */
  commandTimeout: 2 * SECOND,
  /** Between two non-protective messages (API.md 1.1); an Off never waits for it. */
  sendGap: 800,
  /** After a connection that never got a byte: 1 s before the next one, doubled up to 10 s. */
  reopenFirst: SECOND,
  reopenMax: 10 * SECOND,
  /** A request in flight with no byte for this long is cut when a command or an Off waits. */
  stuck: SECOND,
  /** Failed connections: new tries 5 s, 15 s, 30 s, 1, 2 then 5 min. */
  backoff: [5 * SECOND, 15 * SECOND, 30 * SECOND, MINUTE, 2 * MINUTE, 5 * MINUTE],
  /** A connection without traffic is checked by a ping this often. */
  pingEvery: 20 * SECOND,
  /** The DEVICE_FOUND messages of a list: 2 s plus 1 s per device at most, then the list ends. */
  listBase: 2 * SECOND,
  listPerDevice: SECOND,
  listMax: MINUTE,
  /** The publisher sends what is pending every second; unchanged states again every 30 min. */
  flushInterval: SECOND,
  stateHeartbeat: 30 * MINUTE,
  /** "Test the connection" opens a connection at most this often. */
  testCooldown: 10 * SECOND,
  testBudget: 20 * SECOND,
  /**
   * Commands (Gladys waits 5 s for the ack): the ack is given by 3.5 s after the click. A
   * non-protective command still waiting then stays in line (a scene of many lights: each
   * leaves 800 ms after the one before) until `commandMaxAge`, then is dropped unsent.
   */
  commandAck: 3_500,
  commandMaxAge: 30 * SECOND,
  /** An Off not sent at once is tried again during this budget. */
  protectiveRetry: 250,
  protectiveRetryGap: 50,
  /** The full read after a command whose effect was not seen. */
  followUp: 5 * SECOND,
  /**
   * An Off held that never left, whose last send got no answer, or not seen applied, is sent
   * again this often (and at once when a connection opens), whatever the reads.
   */
  guardProbe: 10 * SECOND,
  /** An Off answered "ok" by the Connect but still shown on is sent again this many times at most. */
  resendMax: 3,
  /** A full read judges an Off only when it left this long after the Off was answered. */
  listSettle: 2 * SECOND,
  /** The configuration of Gladys not read: new tries 5 s, 15 s, then every minute. */
  configRetry: [5 * SECOND, 15 * SECOND, MINUTE],
  configAskGap: 2 * SECOND,
  configWait: 3 * SECOND,
  /** A read or a save of /data is waited for this long at most (never a wait that holds an Off). */
  storeWait: 1_500,
};
