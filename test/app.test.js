// -----------------------------------------------------------------------------
// The app end to end on the fake Connect: connection, full read, events,
// commands, Discover, status, button.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CONFIG, F, MINUTE, SECOND, created, setup } from './helpers/app.js';
import { KEY, LAMP, SWITCH } from './helpers/fakeDeako.js';

test('connects, reads the list, publishes the states and the Discover list', async () => {
  const { gladys, world, status } = await setup();
  assert.equal(world.connections, 1);
  assert.equal(world.sent('DEVICE_LIST').length, 1);
  assert.equal(gladys.fake.lastState(F(LAMP, 'power')), 1);
  assert.equal(gladys.fake.lastState(F(LAMP, 'brightness')), 40);
  assert.equal(gladys.fake.lastState(F(SWITCH, 'power')), 0);
  assert.equal(gladys.fake.lastState(F(SWITCH, 'brightness')), undefined);
  const list = gladys.fake.discoveredDevices;
  assert.deepEqual(list.map((d) => d.name).sort(), ['Lamp', 'Lamp']);
  assert.equal(status().connected, true);
  assert.match(status().message.fr, new RegExp(`${KEY} : connecté, 2 appareil`));
});

test('a change at the wall is published at once (EVENT), the brightness kept when absent', async () => {
  const { gladys, world, wait } = await setup();
  world.wall(LAMP, { power: false });
  await wait(10);
  assert.equal(gladys.fake.lastState(F(LAMP, 'power')), 0);
  world.wall(LAMP, { power: true, dim: 75 });
  await wait(10);
  assert.equal(gladys.fake.lastState(F(LAMP, 'power')), 1);
  assert.equal(gladys.fake.lastState(F(LAMP, 'brightness')), 75);
  // A dimmer EVENT without `dim`: the last brightness stays.
  world.push({ type: 'EVENT', data: { target: LAMP, state: { power: false } } });
  await wait(10);
  assert.equal(gladys.fake.lastState(F(LAMP, 'brightness')), 75);
  assert.equal(gladys.fake.lastState(F(LAMP, 'power')), 0);
});

test('on and brightness: one CONTROL each, done once the EVENT shows it', async () => {
  const { world, cmd, gladys } = await setup();
  world.wall(LAMP, { power: false }, { event: false });
  const on = await cmd(F(SWITCH, 'power'), 1);
  assert.equal(on.success, true, on.error);
  assert.deepEqual(world.controls(SWITCH), [{ power: true }]);
  const dim = await cmd(F(LAMP, 'brightness'), 30);
  assert.equal(dim.success, true, dim.error);
  assert.deepEqual(world.controls(LAMP), [{ power: true, dim: 30 }]);
  assert.equal(gladys.fake.lastState(F(LAMP, 'brightness')), 30);
  assert.equal(gladys.fake.lastState(F(SWITCH, 'power')), 1);
});

test('invalid values and features are refused, nothing sent', async () => {
  const { world, cmd } = await setup();
  for (const [feature, value] of [
    [F(LAMP, 'power'), 2],
    [F(LAMP, 'power'), 0.5],
    [F(LAMP, 'power'), ''],
    [F(LAMP, 'brightness'), 101],
    [F(LAMP, 'brightness'), 40.5],
    [F(LAMP, 'brightness'), -1],
    [F(LAMP, 'brightness'), null],
  ]) {
    const ack = await cmd(feature, value);
    assert.equal(ack.success, false, `${feature} ${value}`);
    assert.match(ack.error, /Valeur invalide/);
  }
  const other = await cmd(`ext:deako:light:${LAMP}:color`, 1);
  assert.match(other.error, /ne peut pas être pilotée/);
  const notDimmer = await cmd(F(SWITCH, 'brightness'), 50, created(SWITCH));
  assert.match(notDimmer.error, /pas un variateur/);
  assert.equal(world.sent('CONTROL').length, 0);
  // A numeric string is a number.
  const text = await cmd(F(LAMP, 'brightness'), '55');
  assert.equal(text.success, true, text.error);
});

test('accepted without EVENT: "sent, without confirmation", a full read 5 s later', async () => {
  const { world, cmd, wait } = await setup();
  world.ignoreControl = true;
  const lists = world.sent('DEVICE_LIST').length;
  const ack = await cmd(F(SWITCH, 'power'), 1);
  assert.equal(ack.success, false);
  assert.match(ack.error, /sans confirmation/);
  await wait(6 * SECOND);
  assert.equal(world.sent('DEVICE_LIST').length, lists + 1);
});

test('an EVENT showing another state: "not applied"; DEVICE_BUSY: refused', async () => {
  const { world, cmd } = await setup();
  world.ignoreControl = true;
  world.latency = (m) => {
    if (m.type === 'CONTROL') world.later(() => world.wall(SWITCH, { power: false }), 30);
    return 20;
  };
  const ack = await cmd(F(SWITCH, 'power'), 1);
  assert.match(ack.error, /montre un autre état/);
  world.latency = 20;
  world.busy = 1;
  const busy = await cmd(F(SWITCH, 'power'), 1);
  assert.match(busy.error, /refusé la commande.*DEVICE_BUSY/);
});

test('a command to a device the Connect does not know: refused (DEVICE_UNKNOWN)', async () => {
  const { cmd } = await setup();
  const ghost = 'aaaaaaaa-0000-0000-0000-000000000000';
  const ack = await cmd(F(ghost, 'power'), 1, created(ghost));
  assert.match(ack.error, /DEVICE_UNKNOWN/);
});

test('a scene on 8 lights at once: every light set, 800 ms apart, none dropped', async () => {
  const profile = Array.from({ length: 8 }, (_, i) => ({
    uuid: `0000000${i}-aaaa-bbbb-cccc-dddddddddddd`,
    name: `L${i}`,
    capabilities: 'power+dim',
    state: { power: false, dim: 10 },
  }));
  const { fakeDeako } = await import('./helpers/fakeDeako.js');
  const { testClock } = await import('./kit/index.mjs');
  const clock = testClock();
  const world = fakeDeako({ profile, clock });
  // A slow Connect: every answer takes 600 ms.
  world.latency = 600;
  const devices = profile.map((p) => created(p.uuid, { dimmable: true }));
  const { gladys, act, wait } = await setup({ world, clock, devices });
  const acks = await act(
    Promise.all(
      devices.map((d) =>
        gladys.fake.setValue(d, { external_id: F(d.external_id.split(':')[3], 'brightness') }, 70),
      ),
    ),
  );
  // The first ones acked done; the later ones say they wait in line.
  assert.equal(acks[0].success, true, acks[0].error);
  assert.ok(acks.slice(1).every((a) => a.success || /en file|sans confirmation/.test(a.error)));
  await wait(30 * SECOND);
  for (const p of profile) {
    assert.deepEqual(world.controls(p.uuid), [{ power: true, dim: 70 }], p.uuid);
    assert.equal(world.devices.get(p.uuid).state.dim, 70);
  }
  const at = world.received.filter((r) => r.message.type === 'CONTROL').map((r) => r.at);
  for (let i = 1; i < at.length; i += 1) assert.ok(at[i] - at[i - 1] >= 800, `gap ${i}`);
});

test('two commands of one device waiting are merged into one CONTROL', async () => {
  const { gladys, world, act, app } = await setup();
  world.latency = 900;
  // A read in flight holds the line: both wait, then leave as one.
  app.listNow();
  const device = created(LAMP);
  const [a, b] = await act(
    Promise.all([
      gladys.fake.setValue(device, { external_id: F(LAMP, 'power') }, 1),
      gladys.fake.setValue(device, { external_id: F(LAMP, 'brightness') }, 55),
    ]),
  );
  assert.equal(a.success, true, a.error);
  assert.equal(b.success, true, b.error);
  assert.deepEqual(world.controls(LAMP), [{ power: true, dim: 55 }]);
});

test('a read that left before a command never applies its old state after it', async () => {
  const { gladys, world, cmd, wait, app } = await setup();
  world.foundGap = 400;
  world.wall(SWITCH, { power: false }, { event: false });
  app.listNow(); // a full read: its snapshot shows the switch off
  await wait(100);
  assert.ok(app.listBusy);
  const ack = await cmd(F(SWITCH, 'power'), 1);
  assert.equal(ack.success, true, ack.error);
  await wait(2 * SECOND); // the DEVICE_FOUND (off, older) come after the EVENT (on)
  assert.equal(gladys.fake.lastState(F(SWITCH, 'power')), 1);
  // A change at the wall during a read: its DEVICE_FOUND (older) does not apply either.
  await wait(60 * SECOND);
  app.listNow();
  await wait(100);
  assert.ok(app.listBusy);
  world.wall(LAMP, { power: false });
  await wait(2 * SECOND);
  assert.equal(gladys.fake.lastState(F(LAMP, 'power')), 0);
});

test('full reads every interval, never sooner; a restart keeps the pace (/data)', async () => {
  const { world, wait, app, store, clock } = await setup();
  assert.equal(world.sent('DEVICE_LIST').length, 1);
  await wait(30 * SECOND);
  assert.equal(world.sent('DEVICE_LIST').length, 1);
  await wait(30 * SECOND);
  assert.equal(world.sent('DEVICE_LIST').length, 2);
  await wait(10 * SECOND);
  await app.shutdown();
  // Restarted 10 s after the last read: the next read waits 50 s more.
  const again = await setup({ store, clock, world });
  assert.equal(world.sent('DEVICE_LIST').length, 2);
  await again.wait(45 * SECOND);
  assert.equal(world.sent('DEVICE_LIST').length, 2);
  await again.wait(10 * SECOND);
  assert.equal(world.sent('DEVICE_LIST').length, 3);
  again.app.stop();
});

test('the Connect closes: new tries 5 s then 15 s; no read sooner than the interval', async () => {
  const { world, wait, status } = await setup();
  world.refuse = true;
  world.dropAll();
  await wait(100);
  assert.equal(status().connected, false);
  await wait(5 * SECOND);
  assert.match(status().message.fr, /injoignable/);
  const tries = world.connections;
  world.refuse = false;
  await wait(15 * SECOND);
  assert.equal(world.open, 1);
  assert.ok(world.connections <= tries + 2);
  assert.equal(status().connected, true);
  assert.equal(world.sent('DEVICE_LIST').length, 1, 'read again only at the interval');
  await wait(40 * SECOND);
  assert.equal(world.sent('DEVICE_LIST').length, 2);
});

test('a ping when quiet; no answer closes the connection, a new one is opened', async () => {
  const { world, wait } = await setup();
  await wait(21 * SECOND);
  assert.equal(world.sent('PING').length, 1);
  world.mute.add('PING');
  world.mute.add('DEVICE_LIST');
  await wait(35 * SECOND);
  assert.ok(world.connections >= 2, 'reconnected');
  assert.equal(world.peak, 1, 'never two connections');
});

test('a line over 16 KB closes the connection; garbage is ignored', async () => {
  const { world, wait, gladys } = await setup();
  const socket = [...world.sockets][0];
  socket.feedRaw('not json\r\n{"no":"type"}\r\n[1,2]\r\n');
  socket.feedRaw(
    JSON.stringify({ type: 'EVENT', data: { target: LAMP, state: { power: 'yes' } } }) + '\r\n',
  );
  await wait(10);
  assert.equal(gladys.fake.lastState(F(LAMP, 'power')), 1);
  assert.equal(world.open, 1);
  socket.feedRaw('x'.repeat(17 * 1024));
  await wait(10);
  assert.equal(socket.closed, true);
});

test('getConfig failing in connected: tried again, the status says it, then it starts', async () => {
  let fail = 1;
  const { app, world, wait, status, gladys } = await setup({ start: false, getConfig: undefined });
  const real = gladys.getConfig.bind(gladys);
  gladys.getConfig = async () => {
    if (fail-- > 0) throw new Error('boom');
    return real();
  };
  let finished = false;
  app.onConnected(() => gladys.getConfig()).finally(() => (finished = true));
  await wait(100);
  assert.ok(finished);
  assert.match(status().message.fr, /configuration n’a pas pu être lue/);
  assert.equal(world.connections, 0);
  await wait(6 * SECOND);
  assert.equal(world.connections, 1);
  assert.equal(status().connected, true);
});

test('saving the same address keeps the connection; another address opens a new one', async () => {
  const { gladys, world, wait, act } = await setup();
  await act(gladys.fake.configUpdated({ ...CONFIG, poll_interval: 120 }));
  await wait(100);
  assert.equal(world.connections, 1);
  await act(gladys.fake.configUpdated({ address: '192.168.1.71' }));
  await wait(100);
  assert.equal(world.connections, 2);
  assert.equal(world.peak, 1);
});

test('the status: no address, an address not understood', async () => {
  const empty = await setup({ config: {} });
  assert.match(empty.status().message.fr, /Saisissez l’adresse/);
  assert.equal(empty.world.connections, 0);
  const bad = await setup({ config: { address: 'http://192.168.1.70/x' } });
  assert.match(bad.status().message.fr, /pas comprise/);
});

test('Discover reads only when due; a created device gets its fresh state', async () => {
  const { gladys, world, app, wait, act } = await setup({ devices: [] });
  await act(gladys.fake.scanRequest());
  assert.equal(world.sent('DEVICE_LIST').length, 1, 'read 1 s ago: not again');
  assert.equal(gladys.fake.discoveredDevices.length, 2);
  await act(
    gladys.fake.deviceCreated(gladys.fake.discoveredDevices.find((d) => d.name === 'Living Room')),
  );
  await wait(1100);
  assert.equal(gladys.fake.lastState(F(LAMP, 'power')), 1);
  // Not fresh any more (the connection closed): nothing published at creation.
  world.refuse = true;
  world.dropAll();
  await wait(100);
  await act(
    gladys.fake.deviceCreated(gladys.fake.discoveredDevices.find((d) => d.name === 'Porch')),
  );
  await wait(1100);
  assert.equal(gladys.fake.lastState(F(SWITCH, 'power')), undefined);
  app.stop();
});

test('the test button: a ping; at most one connection try every 10 s', async () => {
  const { app, world, act, wait } = await setup();
  assert.match(await act(app.testConnection()), /répond ; 2 appareil/);
  world.refuse = true;
  world.dropAll();
  await wait(100);
  assert.match(await act(app.testConnection()), /échec/);
  assert.match(await act(app.testConnection()), /moins de 10 s/);
  world.refuse = false;
  await wait(10 * SECOND);
  assert.match(await act(app.testConnection()), /répond/);
});

test('stop: no timer and no request after it', async () => {
  const { app, world, wait, clock } = await setup();
  app.stop();
  const sent = world.received.length;
  await wait(5 * MINUTE);
  assert.equal(world.received.length, sent);
  assert.equal(clock.pending, 0);
});

test('a device not listed yet: a read that left before its command never applies after it', async () => {
  const { gladys, world, cmd, wait, app } = await setup();
  world.wall(SWITCH, { power: true });
  await wait(10);
  assert.equal(gladys.fake.lastState(F(SWITCH, 'power')), 1);
  app.devices.delete(SWITCH);
  world.foundGap = 400;
  world.wall(SWITCH, { power: false }, { event: false });
  app.listNow();
  await wait(100);
  world.noEvent = true; // applied, its EVENT lost
  await cmd(F(SWITCH, 'power'), 1);
  await wait(2 * SECOND);
  assert.equal(world.devices.get(SWITCH).state.power, true);
  assert.equal(gladys.fake.lastState(F(SWITCH, 'power')), 1, 'the older read (off) not applied');
});

test('the time of a full read goes to /data when it starts', async () => {
  const { store, app, wait } = await setup();
  await wait(SECOND);
  assert.ok(store.data.lastListAt > 0);
  assert.ok(Math.abs(store.data.lastListAt - (app.now() - 2 * SECOND)) < 1500);
});

test('a long outage: connection tries spaced out (5 s up to 5 min)', async () => {
  const { world, wait } = await setup();
  world.refuse = true;
  world.dropAll();
  const before = world.attempts;
  await wait(15 * MINUTE);
  // 5, 15, 30, 60, 120, then every 300 s: 7 or 8 over 15 min (never every 5 s).
  const tries = world.attempts - before;
  assert.ok(tries >= 6 && tries <= 9, `${tries} tries`);
});

test('a full read without answer closes the connection, a new one is opened', async () => {
  const { world, wait, app } = await setup();
  world.mute.add('DEVICE_LIST');
  app.listNow();
  await wait(4 * SECOND);
  assert.equal(world.open, 0);
  await wait(6 * SECOND);
  assert.equal(world.connections, 2);
});

test('an EVENT showing another brightness: "not applied"', async () => {
  const { world, cmd } = await setup();
  world.ignoreControl = true;
  world.latency = (m) => {
    if (m.type === 'CONTROL') world.later(() => world.wall(LAMP, { power: true, dim: 50 }), 30);
    return 20;
  };
  const ack = await cmd(F(LAMP, 'brightness'), 30);
  assert.match(ack.error, /montre un autre état/);
});

test('the value written is bounded right before it leaves', async () => {
  const { world, app, act } = await setup();
  await assert.rejects(
    act(app.command(LAMP, { power: true, dim: 150 }, app.monotonic())),
    /Valeur invalide/,
  );
  await assert.rejects(
    act(app.command(LAMP, { power: false, dim: 20 }, app.monotonic())),
    /Valeur invalide/,
  );
  assert.equal(world.sent('CONTROL').length, 0);
});

test('a command not sent within 30 s is dropped, never sent late', async () => {
  const profile = Array.from({ length: 20 }, (_, i) => ({
    uuid: `100000${i.toString(16).padStart(2, '0')}-aaaa-bbbb-cccc-dddddddddddd`,
    name: `L${i}`,
    capabilities: 'power',
    state: { power: false },
  }));
  const { fakeDeako } = await import('./helpers/fakeDeako.js');
  const { testClock } = await import('./kit/index.mjs');
  const clock = testClock();
  const world = fakeDeako({ profile, clock });
  const devices = profile.map((p) => created(p.uuid, { dimmable: false }));
  const { gladys, act, wait } = await setup({ world, clock, devices });
  world.mute.add('CONTROL'); // every command waits 2 s for an answer that never comes
  const pending = devices.map((d) =>
    gladys.fake.setValue(d, { external_id: `${d.external_id}:power` }, 1),
  );
  await act(Promise.all(pending));
  await wait(MINUTE);
  const sent = world.sent('CONTROL').length;
  assert.ok(sent >= 12 && sent < 20, `${sent} sent`);
});
