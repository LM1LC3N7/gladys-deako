// -----------------------------------------------------------------------------
// Offs (power 0, brightness 0): never blocked, kept and sent again until seen
// applied, counted only when answered, never after a newer command.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { F, MINUTE, SECOND, created, setup } from './helpers/app.js';
import { ADDRESS, KEY, LAMP, SWITCH } from './helpers/fakeDeako.js';
import { memoryStore } from '../src/store.js';

const OFF = { power: false };

test('an Off: one CONTROL power false, done once the EVENT shows it; nothing held after', async () => {
  const { world, cmd, app, store, wait } = await setup();
  const ack = await cmd(F(LAMP, 'power'), 0);
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(world.controls(LAMP), [OFF]);
  await wait(10);
  assert.equal(app.guards.size, 0);
  assert.deepEqual(store.data.guards, []);
  // Brightness 0 is an Off too.
  world.wall(LAMP, { power: true });
  const dim0 = await cmd(F(LAMP, 'brightness'), 0);
  assert.equal(dim0.success, true, dim0.error);
  assert.deepEqual(world.controls(LAMP), [OFF, OFF]);
});

test('an Off goes before the commands waiting, without the 800 ms gap', async () => {
  const { world, gladys, act, cmd } = await setup();
  world.latency = 300;
  const a = gladys.fake.setValue(created(SWITCH), { external_id: F(SWITCH, 'power') }, 1);
  const b = gladys.fake.setValue(created(LAMP), { external_id: F(LAMP, 'brightness') }, 80);
  await act(Promise.resolve()); // the first command leaves
  const off = await cmd(F(LAMP, 'power'), 0);
  assert.equal(off.success, true, off.error);
  const order = world.received.filter((r) => r.message.type === 'CONTROL');
  assert.deepEqual(
    order.map((r) => r.message.data.state),
    [{ power: true }, OFF],
    'the brightness of the lamp, clicked before its Off, never leaves',
  );
  assert.ok(order[1].at - order[0].at < 800, 'no gap before an Off');
  const [ackA, ackB] = await act(Promise.all([a, b]));
  assert.equal(ackA.success, true, ackA.error);
  assert.match(ackB.error, /Annulée par une commande plus récente/);
});

test('an Off cuts a read without answer (1 s), on a new connection, never two at once', async () => {
  const { world, cmd, app, wait } = await setup();
  world.mute.add('DEVICE_LIST');
  app.listNow();
  await wait(100);
  const t0 = world.clock.monotonic();
  const ack = await cmd(F(LAMP, 'power'), 0);
  assert.equal(ack.success, true, ack.error);
  const sent = world.received.find((r) => r.message.type === 'CONTROL');
  assert.ok(sent.at - t0 < 1500, `left after ${sent.at - t0} ms`);
  assert.equal(sent.conn, 2);
  assert.equal(world.peak, 1);
  assert.equal(world.connections, 2);
});

test('an Off cuts a command without answer of another device', async () => {
  const { world, gladys, cmd, act } = await setup();
  world.latency = (m) => (m.type === 'CONTROL' && m.data.target === SWITCH ? 10 * SECOND : 20);
  const slow = gladys.fake.setValue(created(SWITCH), { external_id: F(SWITCH, 'power') }, 1);
  await act(Promise.resolve());
  const ack = await cmd(F(LAMP, 'power'), 0);
  assert.equal(ack.success, true, ack.error);
  assert.equal(world.peak, 1);
  const slowAck = await act(slow);
  assert.match(slowAck.error, /sans confirmation/, 'cut: sent, never "nothing sent"');
});

test('a command waits no slow read: the read is cut once stuck', async () => {
  const { world, cmd, app, wait } = await setup();
  world.mute.add('DEVICE_LIST');
  app.listNow();
  await wait(100);
  const ack = await cmd(F(SWITCH, 'power'), 1);
  assert.equal(ack.success, true, ack.error);
  assert.equal(world.peak, 1);
});

test('the Connect unreachable: the Off is kept (in /data) and sent once it answers', async () => {
  const { world, cmd, wait, store, status } = await setup();
  world.refuse = true;
  world.dropAll();
  await wait(100);
  const ack = await cmd(F(LAMP, 'power'), 0);
  assert.equal(ack.success, false);
  assert.match(ack.error, /Arrêt pas encore envoyé.*gardé/);
  assert.equal(world.controls(LAMP).length, 0);
  await wait(10);
  assert.deepEqual(store.data.guards, [{ id: LAMP, left: false, tries: 0 }]);
  assert.match(status().message.fr, /Arrêt de Lamp : pas encore envoyé/);
  // Hours of outage: still held, never given up.
  await wait(2 * 60 * MINUTE);
  world.refuse = false;
  await wait(11 * SECOND);
  assert.deepEqual(world.controls(LAMP), [OFF]);
  await wait(SECOND);
  assert.deepEqual(store.data.guards, []);
});

test('an Off tried again within its 250 ms when the connection fails', async () => {
  const { world, cmd, wait } = await setup();
  world.dropAll();
  world.refuse = true;
  await wait(100);
  // The Connect comes back 100 ms after the click.
  world.later(() => (world.refuse = false), 100);
  const ack = await cmd(F(LAMP, 'power'), 0);
  assert.equal(ack.success, true, ack.error);
});

test('DEVICE_BUSY, no answer: no try counted, sent again every 10 s, never abandoned', async () => {
  const { world, cmd, wait, app } = await setup();
  world.busy = 50;
  const ack = await cmd(F(LAMP, 'power'), 0);
  assert.match(ack.error, /refusé par le Connect.*DEVICE_BUSY.*gardé/);
  await wait(5 * MINUTE);
  const sends = world.controls(LAMP).length;
  assert.ok(sends >= 25, `${sends} sends`);
  assert.equal(app.guards.get(LAMP).tries, 0);
  // No answer at all: the same.
  world.busy = 0;
  world.mute.add('CONTROL');
  await wait(2 * MINUTE);
  assert.equal(app.guards.get(LAMP).tries, 0);
  world.mute.delete('CONTROL');
  await wait(25 * SECOND);
  assert.equal(app.guards.size, 0);
  assert.equal(world.devices.get(LAMP).state.power, false);
});

test('accepted but still on: sent again 10 s apart, 4 answered tries at most, said', async () => {
  const { world, cmd, wait, app, status } = await setup();
  world.ignoreControl = true;
  const ack = await cmd(F(LAMP, 'power'), 0);
  assert.match(ack.error, /sans confirmation/);
  await wait(2 * MINUTE);
  assert.equal(world.controls(LAMP).length, 4);
  const at = world.received.filter((r) => r.message.type === 'CONTROL').map((r) => r.at);
  for (let i = 1; i < at.length; i += 1) assert.ok(at[i] - at[i - 1] >= 10 * SECOND);
  assert.equal(app.guards.get(LAMP).tries, 4);
  assert.match(status().message.fr, /répondu 4 fois.*plus renvoyé/);
  await wait(5 * MINUTE);
  assert.equal(world.controls(LAMP).length, 4);
  // A new click starts again.
  world.ignoreControl = false;
  const again = await cmd(F(LAMP, 'power'), 0);
  assert.equal(again.success, true, again.error);
});

test('an EVENT on after the Off answered: contradicted, sent again', async () => {
  const { world, cmd, wait } = await setup();
  world.ignoreControl = true;
  world.latency = (m) => {
    if (m.type === 'CONTROL') world.later(() => world.wall(LAMP, { power: true }), 40);
    return 20;
  };
  const ack = await cmd(F(LAMP, 'power'), 0);
  assert.match(ack.error, /se montre encore allumé/);
  world.latency = 20;
  world.ignoreControl = false;
  await wait(11 * SECOND);
  assert.deepEqual(world.controls(LAMP), [OFF, OFF]);
  assert.equal(world.devices.get(LAMP).state.power, false);
});

test('a read that left before the Off never contradicts it', async () => {
  const { world, cmd, wait, app } = await setup();
  world.foundGap = 300;
  world.ignoreControl = true; // no EVENT: only the reads judge
  app.listNow(); // snapshot: the lamp on
  await wait(30);
  const ack = await cmd(F(LAMP, 'power'), 0);
  assert.match(ack.error, /sans confirmation/);
  const guard = app.guards.get(LAMP);
  await wait(700); // the DEVICE_FOUND (on) of the older read arrive
  assert.equal(guard.contradicted, false);
});

test('a read that left 2 s after the answer judges the Off: off ends it, on contradicts it', async () => {
  const { world, cmd, wait, app } = await setup();
  world.noEvent = true; // applied, but no EVENT
  const ack = await cmd(F(LAMP, 'power'), 0);
  assert.match(ack.error, /sans confirmation/);
  assert.equal(app.guards.size, 1);
  await wait(6 * SECOND); // the follow-up read shows it off
  assert.equal(app.guards.size, 0);
  // Applied then turned back on (no EVENT): the read contradicts it.
  world.latency = (m) => {
    if (m.type === 'CONTROL')
      world.later(() => world.wall(LAMP, { power: true }, { event: false }), 100);
    return 20;
  };
  await wait(10 * SECOND);
  await cmd(F(LAMP, 'power'), 0);
  await wait(6 * SECOND);
  assert.equal(app.guards.get(LAMP).contradicted, true);
});

test('a newer command of the device that left ends the Off held; refused, the Off stands', async () => {
  const { world, cmd, wait, app } = await setup();
  world.mute.add('CONTROL');
  await cmd(F(LAMP, 'power'), 0);
  world.mute.delete('CONTROL');
  assert.equal(app.guards.size, 1);
  world.busy = 1;
  const busy = await cmd(F(LAMP, 'power'), 1);
  assert.match(busy.error, /DEVICE_BUSY/);
  assert.equal(app.guards.size, 1, 'refused: the Off stands');
  const on = await cmd(F(LAMP, 'power'), 1);
  assert.equal(on.success, true, on.error);
  assert.equal(app.guards.size, 0);
  await wait(MINUTE);
  assert.equal(world.devices.get(LAMP).state.power, true, 'never turned off again');
});

test('a change at the wall after the Off was seen applied is never undone', async () => {
  const { world, cmd, wait } = await setup();
  assert.equal((await cmd(F(LAMP, 'power'), 0)).success, true);
  world.wall(LAMP, { power: true });
  await wait(5 * MINUTE);
  assert.deepEqual(world.controls(LAMP), [OFF]);
  assert.equal(world.devices.get(LAMP).state.power, true);
});

test('at start, an Off of /data leaves first, before the configuration and any read', async () => {
  const store = memoryStore({
    format: 1,
    address: '192.168.1.70:23',
    guards: [{ id: LAMP, left: true, tries: 1 }],
  });
  const { world, wait } = await setup({
    store,
    getConfig: () => new Promise(() => {}),
  });
  await wait(25 * SECOND);
  assert.equal(world.received[0].message.type, 'CONTROL');
  assert.deepEqual(world.controls(LAMP), [OFF]);
  assert.equal(world.sent('DEVICE_LIST').length, 0, 'configuration not read: no read');
  assert.equal(world.sent('PING').length, 0, 'nor a ping');
});

test('at start, an Off accepted before is judged by a read, not sent again', async () => {
  const store = memoryStore({
    format: 1,
    address: KEY,
    guards: [{ id: LAMP, left: true, tries: 1, accepted: true }],
  });
  const { world, wait, app } = await setup({ store });
  await wait(100);
  assert.deepEqual(world.controls(LAMP), []);
  // The lamp shows on (2 s after nothing): contradicted, sent again 10 s later.
  await wait(12 * SECOND);
  assert.deepEqual(world.controls(LAMP), [OFF]);
  await wait(SECOND);
  assert.equal(app.guards.size, 0);
});

test('/data frozen: several Offs leave in a row, at once', async () => {
  const store = memoryStore();
  const { world, cmd, app, wait } = await setup({ store });
  store.hang = true;
  for (const id of [LAMP, SWITCH, LAMP]) {
    world.wall(id, { power: true });
    const ack = await cmd(F(id, 'power'), 0, created(id));
    assert.equal(ack.success, true, ack.error);
  }
  assert.equal(world.sent('CONTROL').length, 3);
  await wait(2 * SECOND);
  assert.equal(app.saveFailed, true);
});

test('/data unreadable at start: the Off still leaves (address typed), nothing written over it', async () => {
  const store = memoryStore({ format: 1, address: KEY, guards: [] });
  store.unreadable = true;
  const { cmd, world, app, wait } = await setup({ store });
  const ack = await cmd(F(LAMP, 'power'), 0);
  assert.equal(ack.success, true, ack.error);
  await wait(100);
  assert.equal(app.storeUnreadable, true);
  assert.equal(store.saves, 0);
  assert.deepEqual(world.controls(LAMP), [OFF]);
});

test('/data that never answers at start: bounded, the Off still leaves', async () => {
  const store = memoryStore();
  store.hangLoad = true;
  const { cmd, world } = await setup({ store });
  const ack = await cmd(F(LAMP, 'power'), 0);
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(world.controls(LAMP), [OFF]);
});

test('an Off before the configuration is read and without /data: waits 3 s for it at most', async () => {
  let release;
  const { app, world, act, gladys } = await setup({
    start: false,
    getConfig: () => new Promise((resolve) => (release = resolve)),
  });
  app.onConnected(() => gladys.getConfig());
  const pending = gladys.fake.setValue(created(LAMP), { external_id: F(LAMP, 'power') }, 0);
  await act(new Promise((resolve) => world.later(resolve, 500)));
  release({ address: ADDRESS });
  const ack = await act(pending);
  assert.equal(ack.success, true, ack.error);
});

test('the Offs of a scene on many devices all leave, none waits the 800 ms gap', async () => {
  const { world, gladys, act } = await setup();
  world.latency = 200;
  const acks = await act(
    Promise.all(
      [LAMP, SWITCH].map((id) =>
        gladys.fake.setValue(created(id), { external_id: F(id, 'power') }, 0),
      ),
    ),
  );
  assert.ok(
    acks.every((a) => a.success),
    JSON.stringify(acks),
  );
});

test('a deleted device: its Off held is dropped', async () => {
  const { world, cmd, app, gladys, wait, act } = await setup();
  world.mute.add('CONTROL');
  await cmd(F(LAMP, 'power'), 0);
  assert.equal(app.guards.size, 1);
  await act(gladys.fake.deviceDeleted(created(LAMP)));
  await wait(MINUTE);
  assert.equal(app.guards.size, 0);
  assert.equal(world.controls(LAMP).length, 1);
});

test('a read that left before the Off was clicked never ends it, even showing off', async () => {
  const { world, cmd, app } = await setup();
  world.mute.add('CONTROL');
  await cmd(F(LAMP, 'power'), 0);
  const guard = app.guards.get(LAMP);
  app.judgeGuard(app.devices.get(LAMP), false, { tick: guard.tick - 1, sentAt: 0 });
  assert.equal(app.guards.get(LAMP), guard);
  app.judgeGuard(app.devices.get(LAMP), false, { tick: guard.tick + 1, sentAt: 0 });
  assert.equal(app.guards.size, 0);
});

test('a read that left less than 2 s after the "ok" does not contradict the Off', async () => {
  const { world, cmd, app, wait } = await setup();
  world.noEvent = true;
  world.eventDelay = 1500; // applied 1.5 s after the "ok", no EVENT
  const ack = await cmd(F(LAMP, 'power'), 0);
  assert.match(ack.error, /sans confirmation/);
  const guard = app.guards.get(LAMP);
  // A read leaves 100 ms after the "ok" (the ack waited 4.3 s: forced right after the send).
  guard.okAt = world.clock.monotonic();
  app.listBusy = false;
  world.devices.get(LAMP).state.power = true;
  app.listNow();
  await wait(200);
  assert.equal(guard.contradicted, false);
});

test('an Off the Connect refuses (DEVICE_UNKNOWN): 4 answered tries, then held without resend', async () => {
  const { world, cmd, app, wait } = await setup();
  const ghost = 'bbbbbbbb-0000-0000-0000-000000000000';
  const ack = await cmd(F(ghost, 'power'), 0, created(ghost));
  assert.match(ack.error, /DEVICE_UNKNOWN/);
  await wait(5 * MINUTE);
  assert.equal(world.controls(ghost).length, 4);
  assert.equal(app.guards.get(ghost).tries, 4);
});

test('a device deleted while its Off waits for a connection: nothing leaves', async () => {
  const { world, cmd, wait, gladys, act } = await setup();
  world.refuse = true;
  world.dropAll();
  await wait(100);
  await cmd(F(LAMP, 'power'), 0);
  await wait(9 * SECOND); // the tries of the connection fail meanwhile (next one in 30 s)
  world.refuse = false;
  world.connectDelay = 1500;
  await wait(1500); // the probe (10 s): a connection opening for the Off
  assert.equal(world.open, 0);
  await act(gladys.fake.deviceDeleted(created(LAMP)));
  await wait(5 * SECOND);
  assert.equal(world.controls(LAMP).length, 0);
});

test('an Off whose connection takes 1.8 s still leaves with the click', async () => {
  const { world, cmd, wait } = await setup();
  world.dropAll();
  await wait(100);
  world.connectDelay = 1800;
  const ack = await cmd(F(LAMP, 'power'), 0);
  assert.equal(ack.success, true, ack.error);
  assert.deepEqual(world.controls(LAMP), [OFF]);
});

test('the quick tries of an Off do not stretch the pause of the connection', async () => {
  const { world, cmd, wait, app } = await setup();
  world.refuse = true;
  world.dropAll();
  await wait(100);
  await cmd(F(LAMP, 'power'), 0);
  assert.ok(app.failures <= 2, `${app.failures} failures`);
});

test('a command clicked while the Off of its device is in flight is refused, never sent', async () => {
  const { world, gladys, act } = await setup();
  world.latency = 300;
  const off = gladys.fake.setValue(created(LAMP), { external_id: F(LAMP, 'power') }, 0);
  await act(new Promise((resolve) => world.later(resolve, 50)));
  const on = await act(gladys.fake.setValue(created(LAMP), { external_id: F(LAMP, 'power') }, 1));
  assert.match(on.error, /arrêt est en cours/);
  assert.equal((await act(off)).success, true);
  assert.deepEqual(world.controls(LAMP), [OFF]);
});

test('a contradicted Off is sent again 10 s after its last send, even when a connection opens', async () => {
  const { world, cmd, wait } = await setup();
  world.ignoreControl = true;
  world.latency = (m) => {
    if (m.type === 'CONTROL') world.later(() => world.wall(LAMP, { power: true }), 40);
    return 20;
  };
  await cmd(F(LAMP, 'power'), 0); // contradicted at once; the ack takes ~4.3 s
  world.dropAll(); // a new connection 5 s later (~9.3 s after the send)
  await wait(5300);
  assert.equal(world.open, 1);
  assert.equal(world.controls(LAMP).length, 1, 'not sent again at the opening');
  await wait(2 * SECOND);
  assert.equal(world.controls(LAMP).length, 2);
});
