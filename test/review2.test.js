// -----------------------------------------------------------------------------
// Review r2: several Offs held against a Connect whose single slot is taken
// (closes at once) or a silent Connect: connections spaced out (1 s doubled up
// to 10 s after connections that never got a byte), each Off sent again 10 s
// apart at most; everything delivered once the Connect answers again.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { F, SECOND, created, setup } from './helpers/app.js';
import { fakeDeako } from './helpers/fakeDeako.js';
import { testClock } from './kit/index.mjs';

function profileOf(n) {
  return Array.from({ length: n }, (_, i) => ({
    uuid: `3000000${i}-aaaa-bbbb-cccc-dddddddddddd`,
    name: `L${i}`,
    capabilities: 'power',
    state: { power: true },
  }));
}

async function offsHeld(n, trouble) {
  const clock = testClock();
  const profile = profileOf(6);
  const world = fakeDeako({ profile, clock });
  const devices = profile.map((p) => created(p.uuid, { dimmable: false }));
  const env = await setup({ world, clock, devices });
  if (trouble === 'slot') {
    world.dropAll();
    await env.wait(10);
    world.open = 1; // another client holds the single slot: ours closed at accept
  } else {
    world.silent = true; // reads everything, answers nothing
  }
  const from = world.attempts;
  const writes = world.sent('CONTROL').length;
  await env.act(
    Promise.all(
      devices
        .slice(0, n)
        .map((d) => env.gladys.fake.setValue(d, { external_id: `${d.external_id}:power` }, 0)),
    ),
  );
  return { ...env, profile, from, writes };
}

/** Each Off sent again 10 s after its last send at the earliest (a little early for the probe). */
function spaced(world, profile, n) {
  for (const p of profile.slice(0, n)) {
    const at = world.received
      .filter((r) => r.message.type === 'CONTROL' && r.message.data.target === p.uuid)
      .map((r) => r.at);
    for (let i = 1; i < at.length; i += 1) {
      assert.ok(at[i] - at[i - 1] >= 8.9 * SECOND, `${p.uuid} gap ${at[i] - at[i - 1]}`);
    }
  }
}

for (const n of [1, 2, 5]) {
  test(`N1: ${n} Off(s) held, the slot of the Connect taken: connections spaced out`, async () => {
    const { world, wait, profile, from } = await offsHeld(n, 'slot');
    await wait(15 * SECOND);
    const tries = world.attempts - from;
    assert.ok(tries <= 8, `${tries} connections in ~19 s`);
    for (let i = from + 1; i < world.attemptAt.length; i += 1) {
      assert.ok(world.attemptAt[i] - world.attemptAt[i - 1] >= 900, `gap ${i}`);
    }
    spaced(world, profile, n);
    // The slot freed: every Off delivered at the next try (10 s at most), all at once.
    world.open = 0;
    await wait(11 * SECOND);
    for (const p of profile.slice(0, n)) {
      assert.equal(world.devices.get(p.uuid).state.power, false, p.uuid);
    }
  });

  test(`N2: ${n} Off(s) held, a silent Connect: about one cut per 10 s, each Off 10 s apart`, async () => {
    const { world, wait, profile, from } = await offsHeld(n, 'silent');
    // It still pushes EVENTs (another device at the wall): bytes, never an answer.
    for (let t = 0; t < 40; t += 1) {
      world.wall(profile[5].uuid, { power: t % 2 === 0 });
      await wait(SECOND);
    }
    const tries = world.attempts - from;
    assert.ok(tries <= 10, `${tries} connections in ~44 s`);
    spaced(world, profile, n);
    assert.equal(world.peak, 1);
    world.silent = false;
    await wait(12 * SECOND);
    for (const p of profile.slice(0, n)) {
      assert.equal(world.devices.get(p.uuid).state.power, false, p.uuid);
    }
  });
}

test('a connection that got bytes resets the pause: the next one opens at once', async () => {
  const { world, cmd, wait } = await setup();
  world.dropAll(); // the first connection was alive (it answered)
  await wait(10);
  const t0 = world.clock.monotonic();
  const ack = await cmd(F(profileOf(1)[0].uuid, 'power'), 0, created(profileOf(1)[0].uuid));
  void ack;
  assert.ok(world.attemptAt.at(-1) - t0 < 100, 'no pause after a live connection');
});

test('after dead connections, a live one resets the pause: the next opens at once', async () => {
  const { world, cmd, wait, app } = await setup();
  world.refuse = true;
  world.dropAll();
  await wait(10);
  await cmd(F(profileOf(1)[0].uuid, 'power'), 0, created(profileOf(1)[0].uuid)); // refused: dead
  assert.ok(app.link.deadStreak >= 1);
  world.refuse = false;
  // The probe connects; the Connect answers its Off: alive. Dropped right after.
  for (let i = 0; i < 150 && !app.conn?.answered; i += 1) await wait(100);
  assert.equal(world.open, 1);
  world.dropAll();
  await wait(10);
  const t0 = world.clock.monotonic();
  await cmd(F(profileOf(1)[0].uuid, 'power'), 0, created(profileOf(1)[0].uuid));
  assert.ok(world.attemptAt.at(-1) - t0 < 100, 'no pause after a live connection');
});
