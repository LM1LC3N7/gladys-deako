// -----------------------------------------------------------------------------
// The app against the SDK's fake Gladys, a fake Deako Connect and the virtual
// clock of the shared test kit: every read of `now()` or `monotonic()` moves
// the time by 1 µs, so a decision reading the clock twice is caught.
// -----------------------------------------------------------------------------

import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { testClock } from '../kit/index.mjs';
import { App } from '../../src/app.js';
import { buildDevice } from '../../src/devices.js';
import { registerHandlers } from '../../src/handlers.js';
import { memoryStore } from '../../src/store.js';
import { ADDRESS, LAMP, SWITCH, fakeDeako } from './fakeDeako.js';

export const SELECTOR = 'deako';
export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const START = Date.UTC(2026, 10, 5, 12, 0, 0);
export const CONFIG = { address: ADDRESS };

/** The external id of a feature: `F(LAMP, 'power')`. */
export const F = (id, key) => `ext:${SELECTOR}:light:${id}${key ? `:${key}` : ''}`;

/** A device as the user created it from the Discovery list. */
export function created(id = LAMP, { dimmable = id === LAMP, name = 'Lamp' } = {}) {
  const gladys = createFakeGladys({ selector: SELECTOR });
  return buildDevice(gladys, { id, name, dimmable }, { language: 'fr' });
}

export const settle = async (rounds = 30) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

export async function setup({
  config = CONFIG,
  devices = [created(LAMP), created(SWITCH)],
  store = memoryStore(),
  clock = testClock({ start: START }),
  world,
  getConfig,
  start: autoStart = true,
} = {}) {
  world ??= fakeDeako({ clock });
  world.clock = clock;
  const gladys = createFakeGladys({ selector: SELECTOR, config, devices });
  await gladys.connect();
  if (getConfig) gladys.getConfig = getConfig;
  const lines = [];
  const log = (...args) => lines.push(args.map(String).join(' '));
  const app = new App({
    gladys,
    logger: { lines, info: log, warn: log, error: log, debug: log },
    connect: world.connect,
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
    store,
  });
  registerHandlers(gladys, app, { error: log });
  async function wait(ms) {
    await clock.advance(ms);
    await settle();
  }
  /** Connects as the SDK does ('connected' -> onConnected), then lets 1 s pass. */
  const start = async () => {
    let finished = false;
    app
      .onConnected(() => gladys.getConfig())
      .finally(() => {
        finished = true;
      });
    // Not awaited for ever: a Gladys that never answers getConfig is a case under test.
    for (let i = 0; i < 50 && !finished; i += 1) await wait(20);
    await wait(1000);
  };
  /** Awaits a promise while the virtual clock moves (10 ms steps); bounded. */
  const act = async (promise, max = 60_000) => {
    let done = false;
    const result = promise.then(
      (value) => {
        done = true;
        return { value };
      },
      (error) => {
        done = true;
        return { error };
      },
    );
    await settle();
    for (let t = 0; !done && t < max; t += 10) {
      await clock.advance(10);
      await settle(3);
    }
    if (!done) throw new Error('the promise did not settle');
    const { value, error } = await result;
    if (error) throw error;
    return value;
  };
  /** A command through the fake Gladys; its ack awaited while the clock moves. */
  const cmd = (featureId, value, device = devices[0]) =>
    act(gladys.fake.setValue(device, { external_id: featureId }, value));
  const status = () => gladys.fake.connectionStatus;
  /** The last state published for a feature. */
  const stateOf = (featureId) => gladys.fake.lastState?.(featureId);
  if (autoStart) await start();
  return { app, gladys, clock, store, world, start, wait, act, cmd, lines, status, stateOf };
}
