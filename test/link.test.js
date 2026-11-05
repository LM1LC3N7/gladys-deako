// -----------------------------------------------------------------------------
// The line to the Connect (src/link.js): one request in flight, priorities,
// the 800 ms gap, the cut of a stuck request, one connection at a time.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testClock } from './kit/index.mjs';
import { DeakoLink, LinkError } from '../src/link.js';
import { PRIORITY } from '../src/constants.js';
import { controlRequest, listRequest, pingRequest } from '../src/protocol.js';
import { LAMP, SWITCH, fakeDeako } from './helpers/fakeDeako.js';
import { settle } from './helpers/app.js';

function setupLink() {
  const clock = testClock();
  const world = fakeDeako({ clock });
  const messages = [];
  const closes = [];
  const link = new DeakoLink({
    host: '192.168.1.70',
    port: 23,
    connect: world.connect,
    monotonic: clock.monotonic,
    timers: clock.timers,
    onMessage: (m) => messages.push(m),
    onClose: (conn, reason) => closes.push(reason),
  });
  const run = async (promise, max = 30_000) => {
    let out;
    promise.then(
      (value) => (out = { value }),
      (error) => (out = { error }),
    );
    for (let t = 0; !out && t < max; t += 10) {
      await clock.advance(10);
      await settle(3);
    }
    if (!out) throw new Error('did not settle');
    return out;
  };
  return { clock, world, link, messages, closes, run };
}

test('one request in flight: the next leaves after the answer and 800 ms', async () => {
  const { world, link, run } = setupLink();
  world.latency = 300;
  const a = link.request(pingRequest(), { priority: PRIORITY.READ });
  const b = link.request(pingRequest(), { priority: PRIORITY.READ });
  const [ra, rb] = await Promise.all([run(a), run(b)]);
  assert.equal(ra.value.status, 'ok');
  assert.equal(rb.value.status, 'ok');
  const [t1, t2] = world.received.map((r) => r.at);
  assert.ok(t2 - t1 >= 800, `${t2 - t1}`);
  assert.ok(t2 - t1 >= 300, 'after the answer');
  link.stop();
});

test('an Off leaves without the gap, before the requests queued earlier', async () => {
  const { world, link, run } = setupLink();
  await run(link.request(pingRequest()));
  const read = link.request(listRequest(), { priority: PRIORITY.READ });
  const off = link.request(controlRequest(LAMP, { power: false }), {
    priority: PRIORITY.PROTECTIVE,
  });
  await run(Promise.all([read, off]));
  const types = world.received.map((r) => r.message.type);
  assert.deepEqual(types, ['PING', 'CONTROL', 'DEVICE_LIST']);
  assert.ok(
    world.received[1].at - world.received[0].at < 800,
    JSON.stringify(world.received.map((r) => r.at)),
  );
  link.stop();
});

test('a stuck request is cut only when a more urgent one waits, after 1 s without a byte', async () => {
  const { world, link, run, clock, closes } = setupLink();
  world.mute.add('DEVICE_LIST');
  const read = link.request(listRequest(), { priority: PRIORITY.READ, timeout: 20_000 });
  read.catch(() => {});
  await clock.advance(500);
  await settle();
  // Same priority behind: no cut, it waits (bounded by the timeout).
  const ping = link.request(pingRequest(), { priority: PRIORITY.READ, deadline: Infinity });
  ping.catch(() => {});
  await clock.advance(2000);
  await settle();
  assert.equal(world.connections, 1);
  const off = link.request(controlRequest(LAMP, { power: false }), {
    priority: PRIORITY.PROTECTIVE,
  });
  const start = clock.monotonic();
  const out = await run(off);
  assert.equal(out.value.status, 'ok');
  assert.deepEqual(closes, ['cut']);
  assert.equal(world.peak, 1);
  assert.ok(clock.monotonic() - start < 200, 'already stuck for more than 1 s: cut at once');
  const cut = await run(read);
  assert.ok(cut.error instanceof LinkError);
  assert.equal(cut.error.code, 'cut');
  assert.equal(cut.error.sent, true);
  link.stop();
});

test('a request receiving bytes is not cut; a command cuts a stuck read too', async () => {
  const { world, link, run, clock, closes } = setupLink();
  world.mute.add('CONTROL');
  const slow = link.request(controlRequest(SWITCH, { power: true }), {
    priority: PRIORITY.COMMAND,
    timeout: 5000,
  });
  slow.catch(() => {});
  await clock.advance(100);
  const off = link.request(controlRequest(LAMP, { power: false }), {
    priority: PRIORITY.PROTECTIVE,
  });
  off.catch(() => {});
  // Bytes keep coming (EVENTs of other devices): not stuck.
  for (let i = 0; i < 5; i += 1) {
    world.wall(SWITCH, { power: i % 2 === 0 });
    await clock.advance(500);
    await settle();
  }
  assert.deepEqual(closes, []);
  world.mute.delete('CONTROL'); // the slow one stays without answer (already received)
  await clock.advance(1100);
  await settle();
  assert.deepEqual(closes, ['cut']);
  assert.equal((await run(off)).value.status, 'ok');
  // A command behind a stuck read cuts it.
  world.mute.add('DEVICE_LIST');
  const read = link.request(listRequest(), { priority: PRIORITY.READ, timeout: 20_000 });
  read.catch(() => {});
  await clock.advance(900); // the read leaves (after the gap), then stays without answer
  await settle();
  assert.equal(world.sent('DEVICE_LIST').length, 1);
  const command = link.request(controlRequest(SWITCH, { power: true }), {
    priority: PRIORITY.COMMAND,
  });
  assert.equal((await run(command)).value.status, 'ok');
  assert.deepEqual(closes, ['cut', 'cut']);
  link.stop();
});

test('not sent: deadline passed, beforeSend refusing, connection refused', async () => {
  const { world, link, run, clock } = setupLink();
  await run(link.request(pingRequest()));
  const late = await run(link.request(pingRequest(), { deadline: clock.monotonic() - 1 }));
  assert.equal(late.error.code, 'late');
  assert.equal(late.error.sent, false);
  const refused = await run(
    link.request(pingRequest(), {
      beforeSend: () => {
        throw new Error('no');
      },
    }),
  );
  assert.equal(refused.error.message, 'no');
  assert.equal(world.received.length, 1, 'the first ping only');
  link.close();
  world.refuse = true;
  const down = await run(link.request(pingRequest()));
  assert.equal(down.error.code, 'network');
  assert.equal(down.error.sent, false);
  link.stop();
});

test('answers: DEVICE_BUSY and other errors; a timeout is "sent"', async () => {
  const { world, link, run } = setupLink();
  world.busy = 1;
  const busy = await run(link.request(controlRequest(LAMP, { power: false })));
  assert.equal(busy.error.code, 'busy');
  assert.equal(busy.error.sent, true);
  const unknown = await run(link.request(controlRequest('nope-1', { power: false })));
  assert.equal(unknown.error.code, 'refused');
  assert.equal(unknown.error.deviceCode, 'DEVICE_UNKNOWN');
  world.mute.add('PING');
  const quiet = await run(link.request(pingRequest(), { timeout: 1000 }));
  assert.equal(quiet.error.code, 'timeout');
  assert.equal(quiet.error.sent, true);
  link.stop();
});

test('an answer of another request, or a late one, is not taken for ours', async () => {
  const { world, link, run, messages } = setupLink();
  world.latency = 2000;
  const first = link.request(pingRequest(), { timeout: 500 });
  assert.equal((await run(first)).error.code, 'timeout');
  const second = link.request(pingRequest(), { timeout: 5000 });
  const out = await run(second);
  assert.equal(out.value.transactionId, world.sent('PING')[1].transactionId);
  // The late answer of the first went to onMessage, ignored by the app (not an EVENT).
  assert.ok(messages.some((m) => m.transactionId === world.sent('PING')[0].transactionId));
  link.stop();
});

test('stop: queued and in flight rejected, nothing sent after', async () => {
  const { world, link, run } = setupLink();
  world.mute.add('PING');
  const a = link.request(pingRequest());
  const b = link.request(pingRequest());
  a.catch(() => {});
  b.catch(() => {});
  await run(Promise.resolve());
  link.stop();
  assert.equal((await run(a)).error.code, 'stopped');
  assert.equal((await run(b)).error.code, 'stopped');
  const c = await run(link.request(pingRequest()));
  assert.equal(c.error.code, 'stopped');
  assert.equal(world.sent('PING').length, 1);
});
