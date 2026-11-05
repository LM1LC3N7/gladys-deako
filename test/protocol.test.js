// -----------------------------------------------------------------------------
// The messages of the Deako local API (pure): strict reading, framing.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  cleanName,
  controlRequest,
  deviceCount,
  errorCode,
  isId,
  lineOf,
  lineReader,
  parseDeviceFound,
  parseEvent,
  parseLine,
  validState,
} from '../src/protocol.js';
import { addressOf, normalizeConfig, parseAddress } from '../src/config.js';
import { commandOf, integerOf } from '../src/app.js';

test('requests: one line, CRLF, a transactionId, our src, the Connect as dst', () => {
  const message = controlRequest('abc-1', { power: true, dim: 40 });
  const line = lineOf(message);
  assert.ok(line.endsWith('\r\n'));
  assert.equal(line.indexOf('\n'), line.length - 1);
  const back = JSON.parse(line);
  assert.match(back.transactionId, /^[0-9a-f-]{36}$/);
  assert.equal(back.type, 'CONTROL');
  assert.equal(back.dst, 'deako');
  assert.equal(back.src, 'Gladys');
  assert.deepEqual(back.data, { target: 'abc-1', state: { power: true, dim: 40 } });
  assert.deepEqual(controlRequest('abc-1', { power: false }).data.state, { power: false });
});

test('a state we write: power boolean, dim 1-100 integer with power on', () => {
  assert.equal(validState({ power: false }), true);
  assert.equal(validState({ power: true, dim: 1 }), true);
  assert.equal(validState({ power: true, dim: 100 }), true);
  for (const bad of [
    { power: 1 },
    { power: true, dim: 0 },
    { power: true, dim: 101 },
    { power: true, dim: 4.5 },
    { power: false, dim: 30 },
    null,
  ]) {
    assert.equal(validState(bad), false, JSON.stringify(bad));
  }
});

test('Gladys values: strict integers; 0 is an Off, never a brightness', () => {
  assert.equal(integerOf(''), undefined);
  assert.equal(integerOf(null), undefined);
  assert.equal(integerOf('1.5'), undefined);
  assert.equal(integerOf(' 7 '), 7);
  assert.equal(integerOf(2.5), undefined);
  assert.deepEqual(commandOf('power', 0), { protective: true });
  assert.deepEqual(commandOf('brightness', 0), { protective: true });
  assert.deepEqual(commandOf('power', 1), { target: { power: true } });
  assert.deepEqual(commandOf('brightness', 1), { target: { power: true, dim: 1 } });
  assert.deepEqual(commandOf('brightness', 100), { target: { power: true, dim: 100 } });
  assert.equal(commandOf('brightness', 101), undefined);
  assert.equal(commandOf('power', -1), undefined);
  assert.equal(commandOf('power', undefined), undefined);
  assert.equal(commandOf('other', 1), undefined);
});

test('reading: only JSON objects with a string type; unknown values are unknown, never 0', () => {
  for (const line of ['', 'x', '[1]', '{"a":1}', '{"type":3}', 'null', '"s"']) {
    assert.equal(parseLine(line), undefined, line);
  }
  assert.equal(parseLine('{"type":"EVENT"}').type, 'EVENT');
  const proto = parseLine('{"type":"EVENT","__proto__":{"polluted":1}}');
  assert.equal({}.polluted, undefined);
  assert.equal(proto.type, 'EVENT');
  assert.deepEqual(parseEvent({ target: 'a-1', state: { power: true, dim: 30 } }), {
    id: 'a-1',
    state: { power: true, dim: 30 },
  });
  assert.equal(parseEvent({ target: 'a-1', state: { power: 'on' } }), undefined);
  assert.equal(parseEvent({ target: 'a.1', state: { power: true } }), undefined);
  assert.equal(
    parseEvent({ target: 'a-1', eventType: 'OTHER', state: { power: true } }),
    undefined,
  );
  assert.deepEqual(parseEvent({ target: 'a-1', state: { power: false, dim: 'x' } }).state, {
    power: false,
    dim: undefined,
  });
  assert.equal(
    parseEvent({ target: 'a-1', state: { power: true, dim: 101 } }).state.dim,
    undefined,
  );
  assert.equal(
    parseEvent({ target: 'a-1', state: { power: true, dim: 2.5 } }).state.dim,
    undefined,
  );
});

test('DEVICE_FOUND: capabilities, older API without them, names cleaned', () => {
  const dimmer = parseDeviceFound({
    name: ' Living\u0007 Room ',
    uuid: 'u-1',
    capabilities: 'power+dim',
    state: { power: false, dim: 21 },
  });
  assert.deepEqual(dimmer, {
    id: 'u-1',
    name: 'Living  Room',
    dimmable: true,
    state: { power: false, dim: 21 },
  });
  assert.equal(parseDeviceFound({ uuid: 'u-2', capabilities: 'power', state: {} }).dimmable, false);
  assert.equal(parseDeviceFound({ uuid: 'u-3', state: { power: true, dim: 5 } }).dimmable, true);
  assert.equal(parseDeviceFound({ uuid: 'u-4', state: { power: true } }).dimmable, false);
  assert.equal(parseDeviceFound({ uuid: '', state: {} }), undefined);
  assert.equal(parseDeviceFound({ uuid: 'a:b', state: {} }), undefined);
  assert.equal(parseDeviceFound({ uuid: 'x'.repeat(65), state: {} }), undefined);
  assert.equal(cleanName('x'.repeat(100)).length, 60);
  assert.equal(cleanName('   '), undefined);
  assert.equal(cleanName(5), undefined);
  assert.equal(isId('3748292-28388292-8474728293-8838383'), true);
  assert.equal(isId('-a'), false);
});

test('counts and error codes read strictly', () => {
  assert.equal(deviceCount({ number_of_devices: 3 }), 3);
  assert.equal(deviceCount({ number_of_devices: '3' }), undefined);
  assert.equal(deviceCount({ number_of_devices: -1 }), undefined);
  assert.equal(deviceCount({ number_of_devices: 1.5 }), undefined);
  assert.equal(errorCode({ data: { code: 'DEVICE_BUSY' } }), 'DEVICE_BUSY');
  assert.equal(errorCode({ data: { code: 'busy\r\nX' } }), undefined);
  assert.equal(errorCode({}), undefined);
});

test('lines: split across chunks, glued in one, CR dropped, a line over the limit refused', () => {
  const reader = lineReader(100);
  assert.deepEqual(reader.push(Buffer.from('{"a":')), []);
  assert.deepEqual(reader.push(Buffer.from('1}\r\n{"b":2}\r\n{"c"')), ['{"a":1}', '{"b":2}']);
  assert.deepEqual(reader.push(Buffer.from(':3}\n')), ['{"c":3}']);
  // A UTF-8 character split between two chunks.
  const bytes = Buffer.from('{"n":"é"}\r\n');
  assert.deepEqual(reader.push(bytes.subarray(0, 7)), []);
  assert.deepEqual(reader.push(bytes.subarray(7)), ['{"n":"é"}']);
  assert.throws(() => reader.push(Buffer.alloc(101, 0x41)), { code: 'size' });
  const again = lineReader(100);
  assert.throws(() => again.push(Buffer.from(`${'x'.repeat(150)}\n`)), { code: 'size' });
  // Byte by byte: still linear and right.
  const slow = lineReader(100);
  const out = [];
  for (const byte of Buffer.from('{"x":1}\r\n{"y":2}\r\n'))
    out.push(...slow.push(Buffer.from([byte])));
  assert.deepEqual(out, ['{"x":1}', '{"y":2}']);
});

test('the address: IP or name, port 23 by default; URLs, broadcast, multicast refused', () => {
  assert.deepEqual(parseAddress('192.168.1.70'), { host: '192.168.1.70', port: 23 });
  assert.deepEqual(parseAddress('Deako.lan:2323'), { host: 'deako.lan', port: 2323 });
  assert.deepEqual(parseAddress('telnet://192.168.1.70'), { host: '192.168.1.70', port: 23 });
  assert.deepEqual(parseAddress('[fe80::1]:23'), { host: 'fe80::1', port: 23 });
  for (const bad of [
    'http://192.168.1.70',
    '192.168.1.70/x',
    'a b',
    'user@host',
    '255.255.255.255',
    '224.0.0.251',
    '0.0.0.0',
    'host:0',
    'host:70000',
    'ff02::1',
    'x\r\ny',
  ]) {
    assert.ok(parseAddress(bad).error, bad);
  }
  assert.deepEqual(parseAddress(''), {});
  assert.equal(normalizeConfig({ address: ' 192.168.1.70 ' }).address.key, '192.168.1.70:23');
  assert.equal(normalizeConfig({ address: 'http://x' }).addressError, true);
  assert.equal(normalizeConfig({ poll_interval: '' }).pollInterval, 60);
  assert.equal(normalizeConfig({ poll_interval: 5 }).pollInterval, 30);
  assert.equal(normalizeConfig({ language: 'EN' }).language, 'en');
  assert.equal(addressOf('192.168.1.70:23').port, 23);
  assert.equal(addressOf('192.168.1.70'), undefined);
});
