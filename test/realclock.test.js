// -----------------------------------------------------------------------------
// The app on a REAL moving clock (performance.now, Date.now, setTimeout), sped
// up 20 times, against a real local TCP server playing a Deako Connect: the
// full reads start at the interval (measured), never sooner; a command and an
// Off confirmed by the EVENT; an Off cuts a read without answer on a real
// socket, one connection at a time. Every wait is bounded; the app, the clock
// and the server are stopped in t.after.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { App } from '../src/app.js';
import { registerHandlers } from '../src/handlers.js';
import { memoryStore } from '../src/store.js';
import { measurePeriod, realClock, spyOn, tcpServer } from './kit/index.mjs';
import { created } from './helpers/app.js';
import { LAMP, PROFILE } from './helpers/fakeDeako.js';

const SPEED = 20;
const INTERVAL = 30_000;

async function connectServer() {
  const devices = new Map(PROFILE().map((d) => [d.uuid, d]));
  const line = (m) => `${JSON.stringify(m)}\r\n`;
  const srv = await tcpServer({
    latencyMs: 2,
    onData: (chunk, conn) => {
      let out = '';
      for (const text of chunk.toString('utf8').split('\r\n')) {
        if (!text) continue;
        const m = JSON.parse(text);
        const ok = { transactionId: m.transactionId, type: m.type, src: 'deako', status: 'ok' };
        if (m.type === 'PING') out += line(ok);
        if (m.type === 'DEVICE_LIST' && !srv.muteList) {
          out += line({ ...ok, data: { number_of_devices: devices.size } });
          for (const d of devices.values()) {
            out += line({
              type: 'DEVICE_FOUND',
              data: { name: d.name, uuid: d.uuid, capabilities: d.capabilities, state: d.state },
            });
          }
        }
        if (m.type === 'CONTROL') {
          out += line(ok);
          const d = devices.get(m.data.target);
          setTimeout(() => {
            Object.assign(d.state, m.data.state);
            conn.write(line({ type: 'EVENT', data: { target: d.uuid, state: d.state } }));
          }, 5);
        }
      }
      return out || undefined;
    },
  });
  srv.devices = devices;
  return srv;
}

async function startApp(t, srv) {
  const clock = realClock({ speed: SPEED });
  const device = created(LAMP);
  const gladys = createFakeGladys({
    selector: 'deako',
    config: { address: `127.0.0.1:${srv.port}`, poll_interval: INTERVAL / 1000 },
    devices: [device],
  });
  await gladys.connect();
  const quiet = () => {};
  const app = new App({
    gladys,
    logger: { info: quiet, warn: quiet, error: quiet, debug: quiet },
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
    store: memoryStore(),
  });
  registerHandlers(gladys, app);
  t.after(async () => {
    app.stop();
    clock.close();
    await srv.close();
  });
  return { app, clock, gladys, device };
}

/** A promise bounded in real time: rejects instead of hanging a test. */
const within = (promise, ms) =>
  Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`no answer within ${ms} ms`)), ms).unref(),
    ),
  ]);

test('real clock x20: one full read per interval (measured), a command and an Off done', async (t) => {
  const srv = await connectServer();
  const { app, clock, gladys, device } = await startApp(t, srv);
  const spy = spyOn(app, 'listNow', clock);
  await within(
    app.onConnected(() => gladys.getConfig()),
    5000,
  );
  const gaps = await measurePeriod(spy, { count: 4, period: INTERVAL });
  assert.equal(gaps.length, 3);
  const dim = await within(
    gladys.fake.setValue(device, { external_id: `${device.external_id}:brightness` }, 65),
    5000,
  );
  assert.equal(dim.success, true, dim.error);
  assert.deepEqual(srv.devices.get(LAMP).state, { power: true, dim: 65 });
  const off = await within(
    gladys.fake.setValue(device, { external_id: `${device.external_id}:power` }, 0),
    5000,
  );
  assert.equal(off.success, true, off.error);
  assert.equal(srv.devices.get(LAMP).state.power, false);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.equal(srv.peak, 1);
  app.stop();
  assert.ok(clock.timersSet < 200, `${clock.timersSet} timers`);
});

test('real clock x20: an Off cuts a read without answer, one connection at a time', async (t) => {
  const srv = await connectServer();
  const { app, gladys, device } = await startApp(t, srv);
  await within(
    app.onConnected(() => gladys.getConfig()),
    5000,
  );
  srv.muteList = true;
  // The next read stays without answer.
  app.listBusy = false;
  app.listNow();
  await new Promise((resolve) => setTimeout(resolve, 20));
  const started = performance.now();
  const off = await within(
    gladys.fake.setValue(device, { external_id: `${device.external_id}:power` }, 0),
    5000,
  );
  assert.equal(off.success, true, off.error);
  assert.ok((performance.now() - started) * SPEED < 3000, 'done within 3 s (simulated)');
  assert.equal(srv.devices.get(LAMP).state.power, false);
  assert.equal(srv.connections, 2);
  assert.equal(srv.peak, 1);
});
