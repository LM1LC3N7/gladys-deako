// -----------------------------------------------------------------------------
// A Deako device -> its Gladys device (pure).
//
// `ext:<selector>:light:<uuid>`, `<uuid>` the id the Deako Connect gives the
// device in DEVICE_FOUND (`uuid`, as is): it follows the device whatever the
// address of the Connect. Feature keys (frozen):
//   - `power`       light/binary 0-1 (every device);
//   - `brightness`  light/brightness 0-100 % (dimmers, capability "dim"):
//                   0 = off.
// A device published again never loses a feature: those of the device already
// created in Gladys are kept as they are.
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
} from '@gladysassistant/integration-sdk';
import { DIM, FEATURES as F } from './constants.js';
import { isId } from './protocol.js';
import { FEATURE_NAMES, deviceName, word } from './i18n.js';

export const KIND = 'light';
export const FEATURE_KEYS = Object.values(F);

/** The features of a device: power, and brightness for a dimmer. */
export const featureKeysOf = (device) => (device.dimmable ? [F.POWER, F.BRIGHTNESS] : [F.POWER]);

export function buildFeature(ids, key, language) {
  const base = {
    name: word(FEATURE_NAMES[key], language),
    external_id: ids.feature(key),
    category: C.LIGHT,
    read_only: false,
    has_feedback: true,
    keep_history: true,
  };
  if (key === F.POWER) return { ...base, type: T.LIGHT.BINARY, min: 0, max: 1 };
  if (key === F.BRIGHTNESS) {
    // No unit: the core lists none for the light category (DEVICE_FEATURE_UNITS_BY_CATEGORY).
    return { ...base, type: T.LIGHT.BRIGHTNESS, min: DIM.min, max: DIM.max };
  }
  return undefined;
}

/**
 * The Gladys device of a Deako device `{ id, name, dimmable }`; `created`: the device as Gladys
 * has it (its features kept, the new ones added).
 */
export function buildDevice(gladys, device, { language, created } = {}) {
  const ids = gladys.externalIds(KIND, device.id);
  const features = [];
  const have = new Set();
  for (const feature of created?.features ?? []) {
    const key = featureKeyOf(feature.external_id, ids.device);
    if (key) {
      features.push(feature);
      have.add(key);
    }
  }
  for (const key of featureKeysOf(device)) {
    if (!have.has(key)) features.push(buildFeature(ids, key, language));
  }
  return {
    name: created?.name ?? deviceName(device, language),
    external_id: ids.device,
    model: device.dimmable ? 'Deako dimmer' : 'Deako switch',
    features,
    params: [],
  };
}

/** The feature key of an external id under a device id; undefined when not ours. */
export function featureKeyOf(externalId, deviceId) {
  if (typeof externalId !== 'string' || !externalId.startsWith(`${deviceId}:`)) return undefined;
  const key = externalId.slice(deviceId.length + 1);
  return FEATURE_KEYS.includes(key) ? key : undefined;
}

/** `ext:<selector>:light:<uuid>[:<key>]` -> `{ id, key }`; undefined when not one of ours. */
export function parseExternalId(externalId, selector) {
  const prefix = `ext:${selector}:${KIND}:`;
  if (typeof externalId !== 'string' || !externalId.startsWith(prefix)) return undefined;
  const [id, key, ...rest] = externalId.slice(prefix.length).split(':');
  if (!isId(id) || rest.length > 0) return undefined;
  if (key !== undefined && !FEATURE_KEYS.includes(key)) return undefined;
  return { id, key };
}

/** The states of a device for Gladys: `[[key, value]]`, only the known ones (never 0 for unknown). */
export function valuesOf(device) {
  const out = [];
  const { power, dim } = device.state ?? {};
  if (typeof power === 'boolean') out.push([F.POWER, power ? 1 : 0]);
  if (device.dimmable && Number.isInteger(dim)) out.push([F.BRIGHTNESS, dim]);
  return out;
}
