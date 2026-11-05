// -----------------------------------------------------------------------------
// The configuration of the manifest `config_schema`, normalized.
//
// `address`: the IP address (or name) of the Deako Connect, or of the Deako
// switch acting as the bridge, with `:port` only when it is not 23. A pasted
// URL, a broadcast or multicast address is refused (said in the status).
// -----------------------------------------------------------------------------

import { isIP } from 'node:net';
import { API, POLL_INTERVAL } from './constants.js';

/** Defaults, mirrored by the manifest (checked by test/manifest.test.js). */
export const DEFAULTS = {
  poll_interval: POLL_INTERVAL.default,
  language: 'fr',
};

export const LANGUAGES = ['fr', 'en'];

const HOSTNAME =
  /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;

/**
 * The address typed by the user: `{ host, port }`, `{ error }` when it is not one, `{}`
 * when empty. Taken from gladys-modern-forms 0.1.1 (port 23 by default).
 */
export function parseAddress(raw) {
  let text = String(raw ?? '').trim();
  if (text === '') return {};
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(text) && !/^telnet:\/\//i.test(text)) {
    return { error: 'invalid' };
  }
  text = text.replace(/^telnet:\/\//i, '').replace(/\/$/, '');
  // eslint-disable-next-line no-control-regex
  if (/[/?#@\s\u0000-\u001f\u007f]/.test(text)) return { error: 'invalid' };
  let host = text;
  let port;
  const bracketed = /^\[([^\]]+)\](?::(\d{1,5}))?$/.exec(text);
  if (bracketed) {
    host = bracketed[1];
    port = bracketed[2];
  } else if (isIP(text) !== 6) {
    const withPort = /^([^:]+):(\d{1,5})$/.exec(text);
    if (withPort) {
      host = withPort[1];
      port = withPort[2];
    } else if (text.includes(':')) {
      return { error: 'invalid' };
    }
  }
  if (isIP(host) === 0 && !HOSTNAME.test(host)) return { error: 'invalid' };
  if (isIP(host) === 4 && /^(0\.|255\.255\.255\.255$|22[4-9]\.|23\d\.)/.test(host)) {
    // Neither "this network", the broadcast nor a multicast group.
    return { error: 'invalid' };
  }
  if (isIP(host) === 6 && /^(::$|ff)/i.test(host)) return { error: 'invalid' };
  const portNumber = port === undefined ? API.defaultPort : Number(port);
  if (portNumber < 1 || portNumber > 65535) return { error: 'invalid' };
  return { host: host.toLowerCase(), port: portNumber };
}

/** `host:port` (IPv6 in brackets): the key of an address (/data, status). */
export const addressKey = ({ host, port }) => `${isIP(host) === 6 ? `[${host}]` : host}:${port}`;

/** An address key back to `{ host, port, key }`; undefined when it is not one. */
export function addressOf(key) {
  if (typeof key !== 'string' || key.length > 300) return undefined;
  const parsed = parseAddress(key);
  if (parsed.error || !parsed.host) return undefined;
  return addressKey(parsed) === key ? { ...parsed, key } : undefined;
}

const number = (value) =>
  value === undefined || value === null || value === '' ? NaN : Number(value);

const clamp = (value, { min, max }, fallback) =>
  Number.isFinite(value) ? Math.round(Math.max(min, Math.min(max, value))) : fallback;

export function normalizeConfig(raw = {}) {
  const parsed = parseAddress(raw?.address);
  const language = String(raw?.language ?? DEFAULTS.language)
    .trim()
    .toLowerCase();
  return {
    /** `{ host, port, key }` or undefined. */
    address: parsed.host ? { ...parsed, key: addressKey(parsed) } : undefined,
    addressError: parsed.error !== undefined,
    pollInterval: clamp(number(raw?.poll_interval), POLL_INTERVAL, DEFAULTS.poll_interval),
    language: LANGUAGES.includes(language) ? language : DEFAULTS.language,
  };
}
