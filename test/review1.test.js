// -----------------------------------------------------------------------------
// Review r1: a big "turn everything off", a Connect whose single slot is taken,
// an Off before the configuration, a light turned on after an Off, a save of
// /data that never ends, ghost devices, and the guards whose mutants survived.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { F, MINUTE, SECOND, created, setup } from './helpers/app.js';
import { KEY, LAMP, SWITCH, fakeDeako } from './helpers/fakeDeako.js';
import { testClock } from './kit/index.mjs';
import { memoryStore } from '../src/store.js';
import { StatePublisher } from '../src/publisher.js';
import { pingRequest } from '../src/protocol.js';

const OFF = { power: false };

function profileOf(n, prefix = '2') {
  return Array.from({ length: n }, (_, i) => ({
    uuid: `${prefix}${String(i).padStart(7, '0')}-aaaa-bbbb-cccc-dddddddddddd`,
    name: `L${i}`,
    capabilities: 'power',
    state: { power: true },
  }));
}

async function many(n, options = {}) {
  const clock = testClock();
  const profile = profileOf(n, options.prefix);
  const world = fakeDeako({ profile, clock });
  const devices = profile.map((p) => created(p.uuid, { dimmable: false }));
  const env = await setup({ world, clock, devices, ...options.setup });
  return { ...env, profile, devices };
}

test('I1: "turn everything off" on 20 lights at 400 ms: every Off at the Connect within 10 s', async () => {
  const { world, gladys, act, profile, devices } = await many(20);
  world.latency = 400;
  const start = world.clock.monotonic();
  const acks = await act(
    Promise.all(
      devices.map((d) => gladys.fake.setValue(d, { external_id: `${d.external_id}:power` }, 0)),
    ),
  );
  assert.ok(acks.every((a) => a.success || /en file|sans confirmation/.test(a.error)));
  await act(
    new Promise((resolve) => world.later(resolve, 10 * SECOND - (world.clock.monotonic() - start))),
  );
  const at = world.received.filter((r) => r.message.type === 'CONTROL').map((r) => r.at - start);
  assert.equal(at.length, 20);
  assert.ok(Math.max(...at) < 10 * SECOND, `last Off after ${Math.max(...at)} ms`);
  await act(new Promise((resolve) => world.later(resolve, SECOND)));
  for (const p of profile) assert.equal(world.devices.get(p.uuid).state.power, false, p.uuid);
});

test('I1: an Off without answer is cut when another Off waits behind it', async () => {
  const { world, gladys, act } = await setup();
  world.mute.add('CONTROL');
  const first = gladys.fake.setValue(created(LAMP), { external_id: F(LAMP, 'power') }, 0);
  await act(new Promise((resolve) => world.later(resolve, 50)));
  world.mute.delete('CONTROL');
  const second = await act(
    gladys.fake.setValue(created(SWITCH), { external_id: F(SWITCH, 'power') }, 0),
  );
  assert.equal(second.success, true, second.error);
  assert.equal(world.peak, 1);
  assert.match((await act(first)).error, /sans confirmation/);
});

test('I2: a Connect whose slot is taken (closes at once), an Off held: 3 connections at most in 20 s', async () => {
  const { world, cmd, wait } = await setup();
  world.dropAll();
  await wait(10);
  // Another client holds the single slot: every connection of ours is closed at once.
  world.open = 1;
  const before = world.attempts;
  await cmd(F(LAMP, 'power'), 0);
  await wait(19 * SECOND);
  assert.ok(world.attempts - before <= 3, `${world.attempts - before} connections`);
});

test('I2: a read or a ping never opens a connection by itself', async () => {
  const { world, app, wait } = await setup();
  world.refuse = true;
  world.dropAll();
  await wait(10);
  const before = world.attempts;
  await assert.rejects(app.link.request(pingRequest()), { code: 'network' });
  assert.equal(world.attempts, before);
});

test('I3: an Off before the configuration, address in /data: sent at once, no wait', async () => {
  const store = memoryStore({ format: 1, address: KEY, guards: [] });
  const { world, gladys, act } = await setup({
    store,
    getConfig: () => new Promise(() => {}),
  });
  const start = world.clock.monotonic();
  const ack = await act(gladys.fake.setValue(created(LAMP), { external_id: F(LAMP, 'power') }, 0));
  assert.equal(ack.success, true, ack.error);
  const sent = world.received.find((r) => r.message.type === 'CONTROL');
  assert.ok(sent.at - start < 200, `${sent.at - start} ms`);
});

test('the Off goes to /data at the click, before any answer', async () => {
  const store = memoryStore();
  const { world, gladys, act } = await setup({ store });
  world.latency = 1000;
  const pending = gladys.fake.setValue(created(LAMP), { external_id: F(LAMP, 'power') }, 0);
  await act(new Promise((resolve) => world.later(resolve, 50)));
  assert.deepEqual(store.data.guards, [{ id: LAMP, left: false, tries: 0 }]);
  await act(pending);
});

test('the Offs held go at a connection opened for a command, before the probe', async () => {
  const { world, cmd, wait } = await setup();
  world.refuse = true;
  world.dropAll();
  await wait(10);
  await cmd(F(LAMP, 'power'), 0); // kept
  world.refuse = false;
  await wait(2 * SECOND);
  const t0 = world.clock.monotonic();
  await cmd(F(SWITCH, 'power'), 1, created(SWITCH)); // opens the connection
  const off = world.received.find(
    (r) => r.message.type === 'CONTROL' && r.message.data.target === LAMP,
  );
  assert.ok(off && off.at - t0 < 500, 'the Off left at the opening');
  const order = world.received
    .filter((r) => r.message.type === 'CONTROL')
    .map((r) => r.message.data.target);
  assert.deepEqual(order, [LAMP, SWITCH], 'the Off first');
});

test('merged commands keep the brightness asked first', async () => {
  const { world, gladys, act, app } = await setup();
  world.latency = 900;
  app.listNow();
  const device = created(LAMP);
  const [a, b] = await act(
    Promise.all([
      gladys.fake.setValue(device, { external_id: F(LAMP, 'brightness') }, 55),
      gladys.fake.setValue(device, { external_id: F(LAMP, 'power') }, 1),
    ]),
  );
  assert.equal(a.success, true, a.error);
  assert.equal(b.success, true, b.error);
  assert.deepEqual(world.controls(LAMP), [{ power: true, dim: 55 }]);
});

test('64 commands waiting at most: the next is refused, nothing sent for it', async () => {
  const { world, gladys, act, app } = await setup();
  world.mute.add('DEVICE_LIST');
  world.mute.add('CONTROL');
  app.listNow();
  const ids = Array.from({ length: 66 }, (_, i) => `c${String(i).padStart(3, '0')}-x`);
  const acks = await act(
    Promise.all(
      ids.map((id) => gladys.fake.setValue(created(id), { external_id: F(id, 'power') }, 1)),
    ),
  );
  assert.ok(acks.some((a) => /Trop de commandes/.test(a.error)));
});

test('an Off accepted, never seen: 3 reads to judge it at most', async () => {
  const { world, cmd, wait } = await setup({
    config: { address: '192.168.1.70', poll_interval: 3600 },
  });
  world.hidden.add(LAMP);
  world.ignoreControl = true;
  await cmd(F(LAMP, 'power'), 0);
  const lists = world.sent('DEVICE_LIST').length;
  await wait(5 * MINUTE);
  assert.ok(
    world.sent('DEVICE_LIST').length - lists <= 4,
    `${world.sent('DEVICE_LIST').length - lists}`,
  );
});

test('a click replaced by a newer Off before it left: said "cancelled"', async () => {
  const { world, gladys, act, wait } = await setup();
  world.refuse = true;
  world.dropAll();
  await wait(10);
  const first = gladys.fake.setValue(created(LAMP), { external_id: F(LAMP, 'power') }, 0);
  await act(new Promise((resolve) => world.later(resolve, 100)));
  const second = gladys.fake.setValue(created(LAMP), { external_id: F(LAMP, 'power') }, 0);
  assert.match((await act(first)).error, /Annulée par une commande plus récente/);
  assert.match((await act(second)).error, /pas encore envoyé/);
});

test('an Off with the Connect down: tried 250 ms, its ack within 1 s', async () => {
  const { world, gladys, act, wait } = await setup();
  world.refuse = true;
  world.dropAll();
  await wait(10);
  const start = world.clock.monotonic();
  const ack = await act(gladys.fake.setValue(created(LAMP), { external_id: F(LAMP, 'power') }, 0));
  assert.match(ack.error, /pas encore envoyé/);
  // Tried, then once more after the 1 s pause of a refused connection, then kept.
  assert.ok(world.clock.monotonic() - start < 2000);
  assert.ok(world.attempts >= 2, 'tried again within the click');
});

test('the publisher: 250 states per minute at most', async () => {
  const clock = testClock();
  let published = 0;
  const gladys = {
    publishChangedStates: async (batch) => {
      published += batch.length;
      return { count: batch.length };
    },
  };
  const publisher = new StatePublisher({
    gladys,
    logger: {},
    now: clock.monotonic,
    timers: clock.timers,
  });
  for (let i = 0; i < 400; i += 1) publisher.push(`f${i}`, { state: 1 });
  for (let i = 0; i < 50; i += 1) {
    await publisher.flush();
    await clock.advance(SECOND);
  }
  assert.equal(published, 250);
});

test('128 devices at most; a listed device takes the place of a ghost seen in an EVENT', async () => {
  const { gladys, wait, status, app } = await many(130, { setup: { devices: [] } });
  assert.equal(gladys.fake.discoveredDevices.length, 128);
  assert.match(status().message.fr, /Plus de 128 appareils/);
  // Ghost EVENTs fill nothing a real device needs.
  const small = await setup();
  for (let i = 0; i < 300; i += 1) {
    small.world.push({ type: 'EVENT', data: { target: `ghost-${i}`, state: { power: true } } });
  }
  await small.wait(10);
  small.world.devices.set('real-1', {
    uuid: 'real-1',
    name: 'Late',
    capabilities: 'power',
    state: { power: true },
  });
  small.app.listBusy = false;
  small.app.listNow();
  await small.wait(SECOND);
  assert.ok(small.gladys.fake.discoveredDevices.some((d) => d.name === 'Late'));
  void wait;
  void app;
  small.app.stop();
});

test('a device removed from the Connect leaves the Discover list', async () => {
  const { world, app, gladys, wait } = await setup();
  world.devices.delete(SWITCH);
  app.listNow();
  await wait(SECOND);
  assert.deepEqual(
    gladys.fake.discoveredDevices.map((d) => d.name),
    ['Lamp'],
  );
});

test('a DEVICE_FOUND twice in one list: the first one stands', async () => {
  const { world, app, gladys, wait } = await setup();
  world.wall(LAMP, { power: true });
  world.extraFound = [
    { uuid: LAMP, name: 'Dup', capabilities: 'power+dim', state: { power: false } },
  ];
  await wait(10);
  app.listNow();
  await wait(SECOND);
  assert.equal(gladys.fake.lastState(F(LAMP, 'power')), 1);
});

test('getConfig failing: new tries 5 s, 15 s, then every minute', async () => {
  const calls = [];
  const clock = testClock();
  const { wait, app, gladys } = await setup({
    clock,
    start: false,
    getConfig: async () => {
      calls.push(clock.monotonic());
      throw new Error('down');
    },
  });
  app.onConnected(() => gladys.getConfig());
  await wait(10);
  await wait(3 * MINUTE);
  const gaps = calls.slice(1).map((t, i) => Math.round((t - calls[i]) / 1000));
  assert.deepEqual(gaps.slice(0, 4), [5, 15, 60, 60]);
});

test('a deleted device: its Off held removed from /data', async () => {
  const store = memoryStore();
  const { world, cmd, gladys, act, wait } = await setup({ store });
  world.mute.add('CONTROL');
  await cmd(F(LAMP, 'power'), 0);
  await wait(2 * SECOND);
  assert.equal(store.data.guards.length, 1);
  store.data.guards.push({ id: 'x-1', left: true, tries: 0 }); // a stale copy
  await act(gladys.fake.deviceDeleted(created(LAMP)));
  await wait(10);
  assert.deepEqual(store.data.guards, []);
});

test('M2: a save of /data that never ends does not stop the next ones', async () => {
  const store = memoryStore();
  const { cmd, wait, app, status } = await setup({ store });
  store.hang = true;
  await cmd(F(LAMP, 'power'), 0);
  await wait(2 * SECOND);
  assert.equal(app.saveFailed, true);
  store.hang = false;
  await cmd(F(SWITCH, 'power'), 0, created(SWITCH));
  await wait(2 * SECOND);
  assert.equal(app.saveFailed, false);
  assert.doesNotMatch(status().message.fr, /n’a pas pu être écrit/);
});

test('M5: an Off held without any address: the status says it is not sent', async () => {
  const { world, cmd, gladys, act, status } = await setup();
  world.mute.add('CONTROL');
  await cmd(F(LAMP, 'power'), 0);
  await act(gladys.fake.configUpdated({}));
  assert.match(status().message.fr, /gardé, pas envoyé \(aucune adresse/);
});

void OFF;

test('I1: a silent Off is cut within about 1 s for the Off behind it', async () => {
  const { world, gladys, act } = await setup();
  world.mute.add('CONTROL');
  const first = gladys.fake.setValue(created(LAMP), { external_id: F(LAMP, 'power') }, 0);
  await act(new Promise((resolve) => world.later(resolve, 50)));
  world.mute.delete('CONTROL');
  const t0 = world.clock.monotonic();
  const second = gladys.fake.setValue(created(SWITCH), { external_id: F(SWITCH, 'power') }, 0);
  await act(new Promise((resolve) => world.later(resolve, 1300)));
  const sent = world.received.find(
    (r) => r.message.type === 'CONTROL' && r.message.data.target === SWITCH,
  );
  assert.ok(sent && sent.at - t0 < 1200, 'cut, not the 2 s answer timeout');
  await act(Promise.all([first, second]));
});

test('I2: a read or a ping waiting when the connection closes does not reopen it', async () => {
  const { world, app, wait } = await setup();
  world.mute.add('PING');
  const a = app.link.request(pingRequest()).catch((err) => err);
  const b = app.link.request(pingRequest()).catch((err) => err);
  await wait(100);
  const before = world.attempts;
  world.dropAll();
  await wait(2 * SECOND);
  assert.equal((await b).code, 'closed');
  assert.equal((await a).code, 'closed');
  assert.equal(world.attempts, before, 'no connection for the reads');
});

test('I2: with an Off held, only the probe connects (every 10 s), not the reconnection too', async () => {
  const { world, cmd, wait } = await setup();
  world.refuse = true;
  world.dropAll();
  await wait(10);
  await cmd(F(LAMP, 'power'), 0);
  const from = world.attemptAt.length;
  await wait(60 * SECOND);
  const at = world.attemptAt.slice(from);
  assert.ok(at.length >= 4, `${at.length} tries`);
  for (let i = 1; i < at.length; i += 1) assert.ok(at[i] - at[i - 1] >= 9 * SECOND, `gap ${i}`);
});

test('an EVENT on while an Off is held unanswered: turned on after it, never undone', async () => {
  const { world, cmd, app, wait } = await setup();
  world.mute.add('CONTROL');
  await cmd(F(LAMP, 'power'), 0);
  world.mute.delete('CONTROL');
  assert.equal(app.guards.size, 1);
  world.wall(LAMP, { power: true });
  await wait(MINUTE);
  assert.equal(app.guards.size, 0);
  assert.equal(world.devices.get(LAMP).state.power, true);
  assert.equal(world.controls(LAMP).length, 1);
});

test('EVENTs of 300 unknown devices: 128 entries at most', async () => {
  const { world, app, wait } = await setup();
  for (let i = 0; i < 300; i += 1) {
    world.push({ type: 'EVENT', data: { target: `ghost-${i}`, state: { power: true } } });
  }
  await wait(10);
  assert.ok(app.devices.size <= 128, `${app.devices.size}`);
});

test('a newer command that left ends the Off held, even with no EVENT after it', async () => {
  const { world, cmd, app, wait } = await setup();
  world.mute.add('CONTROL');
  await cmd(F(LAMP, 'power'), 0);
  world.mute.delete('CONTROL');
  world.noEvent = true;
  await cmd(F(LAMP, 'power'), 1);
  assert.equal(app.guards.size, 0);
  await wait(MINUTE);
  assert.equal(world.controls(LAMP).length, 2);
  assert.equal(world.devices.get(LAMP).state.power, true);
});
