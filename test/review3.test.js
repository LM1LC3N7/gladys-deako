// -----------------------------------------------------------------------------
// Review r3: the pause after dead connections (1 s doubled up to 10 s) is for
// the automatic connections (the line opening again, the probe, a
// reconnection), never for a click: the first send of an Off or a command goes
// at once, one such skip per click and per second; the line of a failed try
// and the retries of an Off keep the pause. A stop leaves no timer.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { F, SECOND, created, settle, setup } from './helpers/app.js';
import { LAMP, SWITCH, fakeDeako } from './helpers/fakeDeako.js';
import { testClock } from './kit/index.mjs';
import { DeakoLink } from '../src/link.js';
import { PRIORITY } from '../src/constants.js';
import { controlRequest } from '../src/protocol.js';

const OFF = { power: false };

function bareLink() {
  const clock = testClock();
  const world = fakeDeako({ clock });
  const link = new DeakoLink({
    host: '192.168.1.70',
    port: 23,
    connect: world.connect,
    monotonic: clock.monotonic,
    timers: clock.timers,
  });
  const advance = async (ms) => {
    for (let t = 0; t < ms; t += 10) {
      await clock.advance(10);
      await settle(3);
    }
  };
  /** Awaits `promise` while the virtual clock moves (10 ms steps); bounded, never hangs. */
  const run = async (promise, max = 30 * SECOND) => {
    let out;
    promise.then((value) => (out = { value }));
    for (let t = 0; !out && t < max; t += 10) {
      await clock.advance(10);
      await settle(3);
    }
    if (!out) throw new Error('did not settle');
    return out.value;
  };
  /** An Off on the line; `hurry`: a click. Settles with the answer or the LinkError. */
  const off = (id, hurry = false) =>
    link
      .request(controlRequest(id, OFF), {
        priority: PRIORITY.PROTECTIVE,
        deadline: Infinity,
        hurry,
      })
      .then(
        (answer) => answer,
        (error) => error,
      );
  return { clock, world, link, advance, run, off };
}

/** Lets the virtual time run until the next connection try, then `after` ms more (bounded). */
async function afterNextTry(world, wait, after = 100) {
  const n = world.attempts;
  for (let i = 0; i < 300 && world.attempts === n; i += 1) await wait(100);
  assert.ok(world.attempts > n, 'an automatic try');
  await wait(after);
}

const controlAt = (world, id) =>
  world.received.find((r) => r.message.type === 'CONTROL' && r.message.data.target === id)?.at;

// --- The line ------------------------------------------------------------------

test('R1 line: a click ends the pause an automatic connection is waiting for', async () => {
  const { clock, world, link, advance, run, off } = bareLink();
  world.refuse = true;
  // Tries at 0, 1, 3 and 7 s (each after its pause), all refused.
  for (let i = 0; i < 4; i += 1) assert.equal((await run(off(LAMP))).code, 'network');
  assert.equal(link.deadStreak, 4);
  const background = off(LAMP);
  await advance(100);
  assert.ok(link.backoff, 'the automatic connection waits for its pause (8 s)');
  world.refuse = false;
  const from = world.attempts;
  const t0 = clock.monotonic();
  const click = off(SWITCH, true);
  await settle(5); // no time moves: tried at once
  assert.equal(world.attempts, from + 1);
  assert.ok(world.attemptAt.at(-1) - t0 < 1, `${world.attemptAt.at(-1) - t0} ms`);
  await advance(100);
  assert.equal((await run(background)).status, 'ok');
  assert.equal((await run(click)).status, 'ok');
  link.stop();
});

test('R1 line: a try in progress serves the click; the next automatic one keeps its pause', async () => {
  const { world, link, advance, run, off } = bareLink();
  world.refuse = true;
  world.connectDelay = 500;
  const background = off(LAMP);
  await advance(100);
  assert.ok(link.trying);
  const click = off(SWITCH, true);
  await advance(500);
  assert.equal((await run(background)).code, 'network');
  assert.equal((await run(click)).code, 'network');
  const next = off(LAMP);
  await advance(3 * SECOND);
  assert.equal(world.attempts, 2);
  const gap = world.attemptAt[1] - world.attemptAt[0];
  assert.ok(gap >= 999, `the click joined the try, no second skip (${gap} ms)`);
  assert.equal((await run(next)).code, 'network');
  link.stop();
});

test('R1 line: the requests left by a failed try keep the pause (one skip per click)', async () => {
  const { world, link, advance, run, off } = bareLink();
  world.open = 1; // another client holds the single slot: every connection closed at accept
  const ids = [LAMP, SWITCH, 'a', 'b', 'c'];
  const offs = ids.map((id) => off(id, true));
  await advance(16 * SECOND);
  const at = world.attemptAt;
  assert.ok(at.length <= 5, `${at.length} connections in 16 s`);
  // 1 s, then 2 s, then 4 s: the pause grows, the clicks of the scene skipped it once.
  for (let i = 1; i < at.length; i += 1) {
    assert.ok(at[i] - at[i - 1] >= 1000 * 2 ** (i - 1) - 1, `gap ${i}: ${at[i] - at[i - 1]}`);
  }
  link.stop();
  await run(Promise.all(offs));
});

test('R1 line: clicks in a row on a dead Connect: one connection per second at most', async () => {
  const { world, link, advance, run, off } = bareLink();
  world.refuse = true;
  const clicks = [];
  for (let i = 0; i < 5; i += 1) {
    clicks.push(off(i % 2 ? LAMP : SWITCH, true));
    await advance(200);
  }
  await advance(3 * SECOND);
  const at = world.attemptAt;
  assert.ok(at.length >= 2, 'the clicks are tried');
  for (let i = 1; i < at.length; i += 1) {
    assert.ok(at[i] - at[i - 1] >= 999, `gap ${i}: ${at[i] - at[i - 1]}`);
  }
  await run(Promise.all(clicks));
  link.stop();
});

test('R2 line: a stop during the pause leaves no timer, and no connection after', async () => {
  const { clock, world, link, advance, run, off } = bareLink();
  world.refuse = true;
  await run(off(LAMP));
  await advance(100);
  const waiting = off(LAMP);
  await advance(100);
  assert.ok(link.backoff);
  link.stop();
  await advance(20);
  assert.equal(clock.pending, 0, 'no timer left after stop');
  assert.equal((await run(waiting)).code, 'stopped');
  await advance(2 * SECOND);
  assert.equal(world.attempts, 1);
});

test('R2 line: a stop while the old connection is closing leaves no timer', async () => {
  const clock = testClock();
  const world = fakeDeako({ clock });
  const link = new DeakoLink({
    host: '192.168.1.70',
    port: 23,
    // A socket that never says 'close' once destroyed: the link waits 200 ms for it.
    connect: (options) => {
      const socket = world.connect(options);
      socket.destroy = () => {
        socket.closed = true;
      };
      return socket;
    },
    monotonic: clock.monotonic,
    timers: clock.timers,
  });
  link.open().catch(() => {});
  for (let i = 0; i < 5; i += 1) {
    await clock.advance(10);
    await settle(3);
  }
  assert.ok(link.isOpen);
  link.close();
  assert.ok(link.closeWait, 'waiting for the close');
  link.stop();
  await clock.advance(10);
  await settle(3);
  assert.equal(clock.pending, 0, 'no timer left after stop');
});

// --- The app ---------------------------------------------------------------------

test('R1: an Off held through a long outage; the Connect back, a click Off leaves at once', async () => {
  const { world, cmd, wait, app } = await setup();
  world.refuse = true;
  world.dropAll();
  await wait(10);
  await cmd(F(LAMP, 'power'), 0); // kept: the probe tries every 10 s, the pause grows
  await wait(40 * SECOND);
  assert.ok(app.link.deadStreak >= 4, `${app.link.deadStreak}`);
  await afterNextTry(world, wait);
  world.refuse = false;
  const t0 = world.clock.monotonic();
  const ack = await cmd(F(SWITCH, 'power'), 0, created(SWITCH));
  assert.equal(ack.success, true, ack.error);
  const at = controlAt(world, SWITCH);
  assert.ok(at - t0 < 100, `the Off at the Connect ${at - t0} ms after the click`);
});

test('R1: a click ends the pause of the line in progress (the slot freed meanwhile)', async () => {
  const clock = testClock();
  const profile = [0, 1, 2, 3]
    .map((i) => `4000000${i}-aaaa-bbbb-cccc-dddddddddddd`)
    .map((uuid) => ({
      uuid,
      name: uuid,
      capabilities: 'power',
      state: { power: true },
    }));
  const world = fakeDeako({ profile, clock });
  const devices = profile.map((p) => created(p.uuid, { dimmable: false }));
  const { cmd, wait, app, act, gladys } = await setup({ world, clock, devices });
  world.dropAll();
  await wait(10);
  world.open = 1; // another client holds the single slot
  await act(
    Promise.all(
      devices
        .slice(0, 3)
        .map((d) => gladys.fake.setValue(d, { external_id: `${d.external_id}:power` }, 0)),
    ),
  );
  let waiting = false;
  for (let i = 0; i < 600 && !waiting; i += 1) {
    await wait(50);
    waiting = app.link.backoff !== undefined && app.link.deadStreak >= 2;
  }
  assert.ok(waiting, 'an automatic connection waits for its pause');
  world.open = 0; // the other client left
  const t0 = clock.monotonic();
  const last = profile[3].uuid;
  const ack = await cmd(F(last, 'power'), 0, devices[3]);
  assert.equal(ack.success, true, ack.error);
  assert.ok(controlAt(world, last) - t0 < 100, `${controlAt(world, last) - t0} ms`);
});

test('R1: a command after a long outage leaves at once once the Connect is back', async () => {
  const { world, cmd, wait, app } = await setup();
  world.refuse = true;
  world.dropAll();
  await wait(45 * SECOND); // reconnections at 5, 20, 50 s: the pause grows
  await afterNextTry(world, wait);
  assert.ok(app.link.deadStreak >= 3, `${app.link.deadStreak}`);
  world.refuse = false;
  const t0 = world.clock.monotonic();
  const ack = await cmd(F(SWITCH, 'power'), 1, created(SWITCH));
  assert.equal(ack.success, true, ack.error);
  assert.ok(controlAt(world, SWITCH) - t0 < 100, `${controlAt(world, SWITCH) - t0} ms`);
});

test('R1: the Connect down for a while: a click Off tried once at once, then kept at once', async () => {
  const { world, cmd, wait, app } = await setup();
  world.refuse = true;
  world.dropAll();
  await wait(10);
  await cmd(F(SWITCH, 'power'), 0, created(SWITCH));
  await wait(30 * SECOND);
  assert.ok(app.link.deadStreak >= 3, `${app.link.deadStreak}`);
  await afterNextTry(world, wait);
  const from = world.attempts;
  const t0 = world.clock.monotonic();
  const ack = await cmd(F(LAMP, 'power'), 0);
  assert.match(ack.error, /Arrêt pas encore envoyé.*gardé/);
  assert.ok(world.clock.monotonic() - t0 < 500, `ack after ${world.clock.monotonic() - t0} ms`);
  assert.equal(world.attempts - from, 1, 'one immediate try, no retry within the pause');
  // Never abandoned: the Connect back, the probe sends it.
  world.refuse = false;
  await wait(11 * SECOND);
  assert.deepEqual(world.controls(LAMP), [OFF]);
});

test('R1: a click joining a failed automatic try is retried after the pause, not at once', async () => {
  const { world, wait, app, act, gladys } = await setup();
  world.dropAll(); // the connection was alive: no pause yet
  world.refuse = true;
  world.connectDelay = 500;
  await wait(10);
  app.link.open().catch(() => {}); // an automatic try, refused after 500 ms
  await wait(400);
  assert.ok(app.link.trying);
  const from = world.attempts;
  const ack = await act(gladys.fake.setValue(created(LAMP), { external_id: F(LAMP, 'power') }, 0));
  assert.match(ack.error, /pas encore envoyé/);
  const at = world.attemptAt;
  assert.equal(at.length, from + 1, 'retried once within the click');
  assert.ok(at.at(-1) - at.at(-2) >= 999, `retry ${at.at(-1) - at.at(-2)} ms after the try`);
});

test('R1: a Connect that never accepts: one try (2 s timeout), then the Off kept, no retry', async () => {
  const { world, cmd, wait } = await setup();
  world.dropAll();
  world.connectDelay = 60 * SECOND; // the TCP connect never completes
  await wait(10);
  const from = world.attempts;
  const t0 = world.clock.monotonic();
  const ack = await cmd(F(LAMP, 'power'), 0);
  assert.match(ack.error, /Arrêt pas encore envoyé.*gardé/);
  const took = world.clock.monotonic() - t0;
  assert.ok(took >= 2000 && took < 2500, `ack after ${took} ms`);
  assert.equal(world.attempts - from, 1, 'tried once: its 250 ms of retries are over');
});

test('R1: the "Test the connection" button after a long outage connects at once', async () => {
  const { world, wait, app, act } = await setup();
  world.refuse = true;
  world.dropAll();
  await wait(45 * SECOND); // reconnections at 5, 20, 50 s: the pause grows
  await afterNextTry(world, wait);
  assert.ok(app.link.deadStreak >= 3, `${app.link.deadStreak}`);
  world.refuse = false;
  const from = world.attempts;
  const t0 = world.clock.monotonic();
  assert.match(await act(app.testConnection()), /répond/);
  assert.equal(world.attempts, from + 1);
  assert.ok(world.attemptAt.at(-1) - t0 < 10, `${world.attemptAt.at(-1) - t0} ms`);
});

// --- A stop leaves no timer -----------------------------------------------------

test('R2: a stop while an Off waits for its EVENT, or the pause, leaves no timer', async () => {
  const { world, wait, app, act, gladys, clock } = await setup();
  world.eventDelay = null; // "ok", then no EVENT: the Off watches until its ack
  const pending = gladys.fake.setValue(created(LAMP), { external_id: F(LAMP, 'power') }, 0);
  await wait(200);
  assert.equal(world.controls(LAMP).length, 1);
  app.stop();
  await wait(20);
  assert.equal(clock.pending, 0, 'no timer left after stop');
  assert.equal((await act(pending)).success, false);
});

test('R2: a stop while a command waits for the configuration leaves no timer', async () => {
  const { app, wait, gladys, clock, act } = await setup({
    start: false,
    getConfig: () => new Promise(() => {}),
  });
  app.onConnected(() => gladys.getConfig());
  const pending = gladys.fake.setValue(created(LAMP), { external_id: F(LAMP, 'power') }, 1);
  await wait(500);
  app.stop();
  await wait(20);
  assert.equal(clock.pending, 0, 'no timer left after stop');
  assert.equal((await act(pending)).success, false);
});

test('R2: a stop while the Off of a click waits for the pause leaves no timer', async () => {
  const { world, wait, app, act, gladys, clock } = await setup();
  world.refuse = true;
  world.dropAll();
  await wait(10);
  const first = await act(
    gladys.fake.setValue(created(LAMP), { external_id: F(LAMP, 'power') }, 0),
  );
  assert.match(first.error, /pas encore envoyé/);
  app.link.open().catch(() => {}); // an automatic connection, waiting for its pause
  await wait(100);
  assert.ok(app.link.backoff, 'a connection waits for its pause');
  const link = app.link;
  app.stop();
  await wait(20);
  assert.equal(clock.pending, 0, 'no timer left after stop');
  assert.equal(link.backoff, undefined);
});

test('R1 line: a click while a connection is open is served by it, no skip left for later', async () => {
  const { clock, world, link, advance, run, off } = bareLink();
  world.refuse = true;
  assert.equal((await run(off(LAMP))).code, 'network');
  world.refuse = false;
  world.open = 1; // another client holds the single slot: closed 1 ms after accept
  const background = off(LAMP); // its 1 s pause, then a connection
  // Step until that connection is open (the try over), before the Connect closes it.
  for (let i = 0; i < 4000 && !(link.isOpen && !link.trying); i += 1) {
    await clock.advance(0.5);
    await settle(3);
  }
  assert.ok(link.isOpen && !link.trying, 'open');
  const click = off(SWITCH, true);
  await advance(4 * SECOND);
  const at = world.attemptAt;
  assert.ok(at.length >= 3, `${at.length} connections`);
  // Closed without a byte: the next one (for the click still waiting) after its 2 s pause.
  assert.ok(at[2] - at[1] >= 1990, `the next connection ${at[2] - at[1]} ms after`);
  link.stop();
  await run(Promise.all([background, click]));
});

test('R1 line: an answer ends the pause: the next automatic connection opens at once', async () => {
  const { clock, world, link, advance, run, off } = bareLink();
  world.refuse = true;
  for (let i = 0; i < 3; i += 1) assert.equal((await run(off(LAMP))).code, 'network');
  world.refuse = false;
  assert.equal((await run(off(LAMP))).status, 'ok'); // after its 4 s pause, answered
  assert.equal(link.deadStreak, 0);
  world.dropAll();
  await advance(10);
  assert.ok(!link.isOpen);
  const from = world.attempts;
  const t0 = clock.monotonic();
  const next = off(SWITCH);
  await settle(5); // no time moves: tried at once
  assert.equal(world.attempts, from + 1);
  assert.ok(world.attemptAt.at(-1) - t0 < 1);
  assert.equal((await run(next)).status, 'ok');
  link.stop();
});
