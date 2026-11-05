// -----------------------------------------------------------------------------
// A fake Deako Connect in memory, built from the Deako "local-integrations"
// API.md 1.5 and its fake_device (MIT, Deako): single-line JSON messages, CRLF,
// answers carrying the transactionId, DEVICE_FOUND after the DEVICE_LIST answer,
// an EVENT after a CONTROL is processed. Its timers are those of the test clock.
// `connect({ host, port })` is what the app's link calls (a socket-like object).
// -----------------------------------------------------------------------------

import { EventEmitter } from 'node:events';

export const ADDRESS = '192.168.1.70';
export const KEY = `${ADDRESS}:23`;
export const LAMP = '5813c713-b2d7-461a-8d85-b308675bf200';
export const SWITCH = '1e74aa84-7994-4ca4-9528-775ad37cef5e';

export const PROFILE = () => [
  { uuid: LAMP, name: 'Living Room', capabilities: 'power+dim', state: { power: true, dim: 40 } },
  { uuid: SWITCH, name: 'Porch', capabilities: 'power', state: { power: false } },
];

export function fakeDeako({ profile = PROFILE(), clock } = {}) {
  const world = {
    clock,
    devices: new Map(profile.map((d) => [d.uuid, structuredClone(d)])),
    /** Delay of every answer (ms), or (message) => ms. */
    latency: 20,
    /** After the "ok" of a CONTROL, the EVENT with the new state (ms); null: no EVENT. */
    eventDelay: 30,
    /** Delay between two DEVICE_FOUND (ms); 0: glued to the answer in one chunk. */
    foundGap: 0,
    connectDelay: 5,
    /** Connections refused (ECONNREFUSED). */
    refuse: false,
    /** Connections accepted, nothing ever answered (but the bytes are read). */
    silent: false,
    /** Message types never answered. */
    mute: new Set(),
    /** The next CONTROLs answered DEVICE_BUSY (count). */
    busy: 0,
    /** CONTROLs answered "ok" and not applied (no EVENT). */
    ignoreControl: false,
    /** CONTROLs applied without an EVENT. */
    noEvent: false,
    /** A single client: a second connection is closed at once. */
    singleClient: true,
    connections: 0,
    open: 0,
    peak: 0,
    /** Every message received: { at, conn, message }. */
    received: [],
    sockets: new Set(),
    /** Connections asked by the client (refused ones included). */
    attempts: 0,
    connect: () => {
      world.attempts += 1;
      return openSocket(world);
    },
    /** Messages of `type` received (CONTROL, DEVICE_LIST, PING). */
    sent(type) {
      return world.received.filter((r) => r.message.type === type).map((r) => r.message);
    },
    controls(target) {
      return world
        .sent('CONTROL')
        .filter((m) => target === undefined || m.data?.target === target)
        .map((m) => m.data.state);
    },
    /** A change at the wall: the state, and its EVENT to every client. */
    wall(uuid, state, { event = true } = {}) {
      const device = world.devices.get(uuid);
      Object.assign(device.state, state);
      if (event) world.push(eventOf(uuid, device.state));
    },
    /** Unsolicited message to every open client. */
    push(message) {
      for (const socket of world.sockets) socket.feed(message);
    },
    /** The Connect closes every connection. */
    dropAll() {
      for (const socket of [...world.sockets]) socket.remoteClose();
    },
    later(fn, ms) {
      world.clock.timers.setTimeout(fn, ms);
    },
  };
  return world;
}

export const eventOf = (uuid, state) => ({
  type: 'EVENT',
  src: 'deako',
  timestamp: 1,
  data: { eventType: 'DEVICE_STATE_CHANGE', target: uuid, state: { ...state } },
});

function answerOf(request, extra = {}) {
  return {
    transactionId: request.transactionId,
    type: request.type,
    dst: request.src,
    src: 'deako',
    timestamp: 1,
    status: 'ok',
    ...extra,
  };
}

function openSocket(world) {
  const socket = new EventEmitter();
  socket.closed = false;
  socket.connected = false;
  socket.id = 0;
  socket.setNoDelay = () => {};
  socket.feed = (message) => {
    if (socket.closed || !socket.connected) return;
    socket.emit('data', Buffer.from(`${JSON.stringify(message)}\r\n`));
  };
  socket.feedRaw = (bytes) => {
    if (socket.closed || !socket.connected) return;
    socket.emit('data', Buffer.from(bytes));
  };
  const close = () => {
    if (socket.closed) return;
    socket.closed = true;
    if (world.sockets.delete(socket)) world.open -= 1;
    world.later(() => socket.emit('close'), 0);
  };
  socket.destroy = close;
  socket.end = close;
  socket.remoteClose = () => {
    if (socket.closed) return;
    close();
  };
  socket.write = (text) => {
    if (socket.closed) throw new Error('write after close');
    for (const line of String(text).split('\r\n')) {
      if (line === '') continue;
      const message = JSON.parse(line);
      world.received.push({ at: world.clock.monotonic(), conn: socket.id, message });
      handle(world, socket, message);
    }
    return true;
  };
  world.later(() => {
    if (socket.closed) return;
    if (world.refuse) {
      socket.closed = true;
      const err = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
      socket.emit('error', err);
      return;
    }
    if (world.singleClient && world.open >= 1) {
      // Accepted then closed at once (as a firmware with one slot).
      socket.connected = true;
      world.connections += 1;
      socket.id = world.connections;
      socket.emit('connect');
      socket.closed = true;
      world.later(() => socket.emit('close'), 1);
      return;
    }
    socket.connected = true;
    world.connections += 1;
    socket.id = world.connections;
    world.sockets.add(socket);
    world.open += 1;
    world.peak = Math.max(world.peak, world.open);
    socket.emit('connect');
  }, world.connectDelay);
  return socket;
}

function handle(world, socket, message) {
  if (world.silent || world.mute.has(message.type)) return;
  const delay = typeof world.latency === 'function' ? world.latency(message) : world.latency;
  const send = (fn, ms = delay) =>
    world.later(() => {
      if (!socket.closed) fn();
    }, ms);
  if (message.type === 'PING') {
    send(() => socket.feed(answerOf(message)));
    return;
  }
  if (message.type === 'DEVICE_LIST') {
    send(() => {
      const devices = [...world.devices.values()];
      const answer = answerOf(message, { data: { number_of_devices: devices.length } });
      // Snapshot of the states when the list is handled.
      const found = devices.map((d) => ({
        type: 'DEVICE_FOUND',
        src: 'deako',
        timestamp: 1,
        data: {
          name: d.name,
          uuid: d.uuid,
          capabilities: d.capabilities,
          state: { ...d.state },
        },
      }));
      if (world.foundGap === 0) {
        socket.feedRaw([answer, ...found].map((m) => `${JSON.stringify(m)}\r\n`).join(''));
        return;
      }
      socket.feed(answer);
      found.forEach((m, i) => world.later(() => socket.feed(m), world.foundGap * (i + 1)));
    });
    return;
  }
  if (message.type === 'CONTROL') {
    const target = message.data?.target;
    const device = world.devices.get(target);
    if (world.busy > 0) {
      world.busy -= 1;
      send(() =>
        socket.feed(
          answerOf(message, {
            status: 'error',
            data: { code: 'DEVICE_BUSY', message: 'Device is busy' },
          }),
        ),
      );
      return;
    }
    if (!device) {
      send(() =>
        socket.feed(
          answerOf(message, {
            status: 'error',
            data: { code: 'DEVICE_UNKNOWN', message: 'Device unknown' },
          }),
        ),
      );
      return;
    }
    send(() => {
      socket.feed(answerOf(message));
      if (world.ignoreControl || world.eventDelay === null) return;
      world.later(() => {
        Object.assign(device.state, message.data.state);
        if (!world.noEvent) world.push(eventOf(target, device.state));
      }, world.eventDelay);
    });
  }
}
