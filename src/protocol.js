// -----------------------------------------------------------------------------
// The messages of the Deako local API (pure): the requests we send, and the
// strict reading of what the Connect sends (see src/constants.js). Ported
// from pydeako 0.6.0 (models/_request.py, deako/_deako.py), MIT, Deako.
//
// Strict: `power` must be a boolean and `dim` an integer 0-100, or the value
// is unknown (never 0); a message that is not a JSON object with a string
// `type` is ignored. Only the known fields are read (no merge of what the
// Connect sends into our objects).
// -----------------------------------------------------------------------------

import { randomUUID } from 'node:crypto';
import { API, DIM, LIMITS, TYPES } from './constants.js';

/** A device id of the Connect: letters, digits and dashes (a uuid), never `.` nor `:`. */
export const isId = (value) =>
  typeof value === 'string' &&
  value.length >= 1 &&
  value.length <= LIMITS.idLength &&
  /^[A-Za-z0-9][A-Za-z0-9-]*$/.test(value);

const plain = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** A request: `{ transactionId, type, dst, src, data? }`. */
export function request(type, data) {
  return {
    transactionId: randomUUID(),
    type,
    dst: API.destination,
    src: API.source,
    ...(data === undefined ? {} : { data }),
  };
}

export const listRequest = () => request(TYPES.DEVICE_LIST);
export const pingRequest = () => request(TYPES.PING);

/** A CONTROL request; `state` = { power, dim? } already checked (see validState). */
export function controlRequest(target, state) {
  const body = { power: state.power };
  if (state.dim !== undefined) body.dim = state.dim;
  return request(TYPES.CONTROL, { target, state: body });
}

/** A state we may write: power boolean, dim an integer 1-100 with power on, or absent. */
export function validState(state) {
  if (!plain(state) || typeof state.power !== 'boolean') return false;
  if (state.dim === undefined) return true;
  return (
    state.power === true && Number.isInteger(state.dim) && state.dim >= 1 && state.dim <= DIM.max
  );
}

/** The line we send (the API wants one line, CRLF at the end). */
export const lineOf = (message) => `${JSON.stringify(message)}\r\n`;

/** One line received -> a message object, undefined when it is not one. */
export function parseLine(line) {
  if (typeof line !== 'string' || line.trim() === '') return undefined;
  let value;
  try {
    value = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!plain(value) || typeof value.type !== 'string') return undefined;
  return value;
}

const dimOf = (value) =>
  Number.isInteger(value) && value >= DIM.min && value <= DIM.max ? value : undefined;

/** `{ power, dim }` from a state of the Connect; power undefined when not a boolean. */
export function parseState(state) {
  if (!plain(state)) return { power: undefined, dim: undefined };
  return {
    power: typeof state.power === 'boolean' ? state.power : undefined,
    dim: dimOf(state.dim),
  };
}

/** A name shown in Gladys: no control character, trimmed, cut. */
export function cleanName(value) {
  if (typeof value !== 'string') return undefined;
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').trim();
  if (text === '') return undefined;
  return [...text].slice(0, LIMITS.nameLength).join('');
}

/** The data of a DEVICE_FOUND -> `{ id, name, dimmable, state }`; undefined when unusable. */
export function parseDeviceFound(data) {
  if (!plain(data) || !isId(data.uuid)) return undefined;
  const state = parseState(data.state);
  let dimmable;
  if (typeof data.capabilities === 'string') {
    dimmable = data.capabilities.split('+').includes('dim');
  } else {
    // Older local API versions: no capabilities, a dimmer sends `dim` (as pydeako).
    dimmable = state.dim !== undefined;
  }
  return { id: data.uuid, name: cleanName(data.name), dimmable, state };
}

/** The data of an EVENT DEVICE_STATE_CHANGE -> `{ id, state }`; undefined when unusable. */
export function parseEvent(data) {
  if (!plain(data) || !isId(data.target)) return undefined;
  if (data.eventType !== undefined && data.eventType !== 'DEVICE_STATE_CHANGE') return undefined;
  const state = parseState(data.state);
  if (state.power === undefined) return undefined;
  return { id: data.target, state };
}

/** `number_of_devices` of a DEVICE_LIST answer: an integer 0..max, undefined otherwise. */
export function deviceCount(data) {
  const n = plain(data) ? data.number_of_devices : undefined;
  return Number.isInteger(n) && n >= 0 && n <= 10_000 ? n : undefined;
}

/** The error code of an answer with `status: "error"` (a short upper-case word), or undefined. */
export function errorCode(message) {
  const code = plain(message?.data) ? message.data.code : undefined;
  return typeof code === 'string' && /^[A-Z_]{1,40}$/.test(code) ? code : undefined;
}

/**
 * Splits the bytes of a connection into lines (LF, CR dropped), each `maxBytes` at most:
 * `push(chunk)` returns the complete lines, throws `size` when a line is longer.
 */
export function lineReader(maxBytes = LIMITS.lineBytes) {
  let pending = Buffer.alloc(0);
  return {
    push(chunk) {
      const data = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      const lines = [];
      let start = 0;
      // The bytes kept from before hold no LF: the search starts after them (linear).
      let from = pending.length;
      for (;;) {
        const end = data.indexOf(0x0a, from);
        if (end === -1) break;
        if (end - start > maxBytes)
          throw Object.assign(new Error('line too long'), { code: 'size' });
        lines.push(data.subarray(start, end).toString('utf8').replace(/\r$/, ''));
        start = end + 1;
        from = start;
      }
      pending = data.subarray(start);
      if (pending.length > maxBytes) {
        pending = Buffer.alloc(0);
        throw Object.assign(new Error('line too long'), { code: 'size' });
      }
      // A copy: the rest no longer holds the whole chunk.
      pending = Buffer.from(pending);
      return lines;
    },
  };
}
