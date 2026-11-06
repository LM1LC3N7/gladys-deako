// -----------------------------------------------------------------------------
// Texts shown in Gladys (connection status, button, device and feature names,
// refusals of a command), in English and French.
// -----------------------------------------------------------------------------

import { FEATURES as F } from './constants.js';

/** The text of `texts` in `language`, English otherwise. */
export const word = (texts, language) => texts[language] ?? texts.en;

export const both = (en, fr) => ({ en, fr });

/** "45 s" / "25 min" / "3 h", for the waits. */
export function age(ms) {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return both(`${seconds} s`, `${seconds} s`);
  const minutes = Math.round(seconds / 60);
  if (minutes < 120) return both(`${minutes} min`, `${minutes} min`);
  const hours = Math.round(minutes / 60);
  return both(`${hours} h`, `${hours} h`);
}

export const FEATURE_NAMES = {
  [F.POWER]: both('Power', 'Allumage'),
  [F.BRIGHTNESS]: both('Brightness', 'Intensité'),
};

/** The id shown to the user: its first 8 characters. */
export const shortId = (id) => String(id).slice(0, 8);

/** The name of a device: its name in the Deako app, else "Deako light 1a2b3c4d". */
export function deviceName(device, language) {
  if (device.name) return device.name;
  return word(
    both(`Deako light ${shortId(device.id)}`, `Lumière Deako ${shortId(device.id)}`),
    language,
  );
}

/** The reason of a failure (a LinkError), in each language. */
export function reasonOf(err) {
  switch (err?.code) {
    case 'network':
      return both(
        `no connection (${String(err.detail ?? 'error').slice(0, 40)})`,
        `pas de connexion (${String(err.detail ?? 'error').slice(0, 40)})`,
      );
    case 'timeout':
      return both('no answer in time', 'pas de réponse à temps');
    case 'late':
      return both('no time left to send', 'plus le temps d’envoyer');
    case 'cut':
      return both('interrupted', 'interrompue');
    case 'closed':
      return both('connection closed', 'connexion fermée');
    case 'busy':
      return both('the Connect is busy (DEVICE_BUSY)', 'le Connect est occupé (DEVICE_BUSY)');
    case 'refused':
      return both(
        `refused by the Connect (${err.deviceCode ?? 'error'})`,
        `refusée par le Connect (${err.deviceCode ?? 'error'})`,
      );
    case 'stopped':
      return both('the integration stops', 'l’intégration s’arrête');
    default:
      return both('internal error', 'erreur interne');
  }
}

export const T = {
  noAddress: both(
    'Enter the address of your Deako Connect.',
    'Saisissez l’adresse de votre Deako Connect.',
  ),
  addressError: both(
    'The address is not understood: an IP address or a name, with :port only if not 23.',
    'L’adresse n’est pas comprise : une adresse IP ou un nom, avec :port seulement si ce n’est pas le 23.',
  ),
  configNotRead: (wait) =>
    both(
      `The configuration could not be read from Gladys; new try in ${wait.en}.`,
      `La configuration n’a pas pu être lue depuis Gladys ; nouvel essai dans ${wait.fr}.`,
    ),
  connecting: (address) => both(`${address}: connecting…`, `${address} : connexion en cours…`),
  connected: (address, n) =>
    both(`${address}: connected, ${n} device(s).`, `${address} : connecté, ${n} appareil(s).`),
  notListed: (address) =>
    both(
      `${address}: connected, the list of devices is not read yet.`,
      `${address} : connecté, la liste des appareils n’est pas encore lue.`,
    ),
  unreachable: (address, reason, wait) =>
    both(
      `${address}: unreachable (${reason.en}), next try in ${wait.en}.`,
      `${address} : injoignable (${reason.fr}), nouvel essai dans ${wait.fr}.`,
    ),
  tooMany: (max) =>
    both(
      `More than ${max} devices: the others are ignored.`,
      `Plus de ${max} appareils : les autres sont ignorés.`,
    ),
  toAdd: (n) =>
    both(`${n} device(s) to add in Discover.`, `${n} appareil(s) à ajouter dans Découverte.`),
  guardNoAddress: (name) =>
    both(
      `Off of ${name}: kept, not sent (no address of the Connect).`,
      `Arrêt de ${name} : gardé, pas envoyé (aucune adresse du Connect).`,
    ),
  guardPending: (name) =>
    both(
      `Off of ${name}: not sent or not answered yet, kept and sent again every 10 s.`,
      `Arrêt de ${name} : pas encore envoyé ou sans réponse, gardé et renvoyé toutes les 10 s.`,
    ),
  guardWaiting: (name, tries) =>
    both(
      `Off of ${name}: accepted by the Connect (${tries} time(s)), not seen applied yet; held.`,
      `Arrêt de ${name} : accepté par le Connect (${tries} fois), pas encore vu appliqué ; gardé.`,
    ),
  guardExhausted: (name) =>
    both(
      `Off of ${name}: answered 4 times by the Connect, still not applied; no longer sent again, click Off to retry.`,
      `Arrêt de ${name} : répondu 4 fois par le Connect, toujours pas appliqué ; plus renvoyé, recliquez sur Arrêt pour réessayer.`,
    ),
  storeProblem: both(
    '/data could not be written: the Offs held are kept in memory only.',
    '/data n’a pas pu être écrit : les arrêts gardés le sont en mémoire seulement.',
  ),
  storeUnreadable: both(
    '/data could not be read: nothing is written over it until it reads again.',
    '/data n’a pas pu être lu : rien n’est écrit par-dessus tant qu’il ne se relit pas.',
  ),
  test: {
    none: both(
      'No address of a Deako Connect in the configuration.',
      'Aucune adresse de Deako Connect dans la configuration.',
    ),
    ok: (address, n) =>
      both(
        `${address}: the Deako Connect answers; ${n} device(s) listed.`,
        `${address} : le Deako Connect répond ; ${n} appareil(s) listé(s).`,
      ),
    failed: (address, reason) =>
      both(`${address}: failed (${reason.en}).`, `${address} : échec (${reason.fr}).`),
    cooldown: (address, wait) =>
      both(
        `${address}: tried less than 10 s ago, new try possible in ${wait.en}.`,
        `${address} : essayé il y a moins de 10 s, nouvel essai possible dans ${wait.fr}.`,
      ),
  },
};

export const ERRORS = {
  notCommandable: both(
    'This feature cannot be driven.',
    'Cette fonctionnalité ne peut pas être pilotée.',
  ),
  badValue: both(
    'Invalid value (0 or 1 for the power, an integer 0-100 for the brightness).',
    'Valeur invalide (0 ou 1 pour l’allumage, un entier de 0 à 100 pour l’intensité).',
  ),
  configNotLoaded: both(
    'The configuration has not been read from Gladys yet: nothing was sent.',
    'La configuration n’a pas encore été lue depuis Gladys : rien n’a été envoyé.',
  ),
  addressUnknown: both(
    'The address of the Deako Connect is not known: nothing was sent.',
    'L’adresse du Deako Connect n’est pas connue : rien n’a été envoyé.',
  ),
  notDimmable: both(
    'This device is not a dimmer: nothing was sent.',
    'Cet appareil n’est pas un variateur : rien n’a été envoyé.',
  ),
  stopPending: both(
    'An Off is being sent to this device: nothing was sent.',
    'Un arrêt est en cours d’envoi à cet appareil : rien n’a été envoyé.',
  ),
  cancelledByStop: both(
    'Cancelled by a newer command (an Off): nothing was sent.',
    'Annulée par une commande plus récente (un arrêt) : rien n’a été envoyé.',
  ),
  queueFull: both(
    'Too many commands waiting: nothing was sent.',
    'Trop de commandes en attente : rien n’a été envoyé.',
  ),
  queued: (ahead) =>
    both(
      `Not sent yet: waiting in line (${ahead} message(s) ahead, 800 ms apart as Deako asks); it leaves within 30 s or is dropped.`,
      `Pas encore envoyée : en file (${ahead} message(s) avant, à 800 ms d’écart comme Deako le demande) ; elle part sous 30 s ou est abandonnée.`,
    ),
  tooOld: both(
    'Not sent within 30 s: dropped, nothing was sent.',
    'Pas envoyée en 30 s : abandonnée, rien n’a été envoyé.',
  ),
  restarting: both(
    'The integration is restarting: nothing was sent.',
    'L’intégration redémarre : rien n’a été envoyé.',
  ),
  notSent: (reason) =>
    both(`Nothing was sent (${reason.en}).`, `Rien n’a été envoyé (${reason.fr}).`),
  rejected: (reason) =>
    both(
      `The Deako Connect refused the command (${reason.en}).`,
      `Le Deako Connect a refusé la commande (${reason.fr}).`,
    ),
  unconfirmed: both(
    'Sent, without confirmation: the devices are read again in 5 s.',
    'Envoyée, sans confirmation : les appareils sont relus dans 5 s.',
  ),
  notApplied: both(
    'Sent and accepted, but the device shows another state: it is read again in 5 s.',
    'Envoyée et acceptée, mais l’appareil montre un autre état : il est relu dans 5 s.',
  ),
  protectiveKept: (reason) =>
    both(
      `Off not sent yet (${reason.en}): kept, and sent as soon as the Connect answers (every 10 s).`,
      `Arrêt pas encore envoyé (${reason.fr}) : gardé, et envoyé dès que le Connect répond (toutes les 10 s).`,
    ),
  offRefused: (reason) =>
    both(
      `Off sent, refused by the Connect (${reason.en}): held, sent again in 10 s.`,
      `Arrêt envoyé, refusé par le Connect (${reason.fr}) : gardé, renvoyé dans 10 s.`,
    ),
  offOverridden: both(
    'Off sent and accepted, then the device was turned on again (at the wall or in the app): no longer held.',
    'Arrêt envoyé et accepté, puis l’appareil a été rallumé (au mur ou dans l’application) : plus gardé.',
  ),
  offQueued: both(
    'Off waiting in line behind other Offs: kept, it leaves as soon as the line is free.',
    'Arrêt en file derrière d’autres arrêts : gardé, il part dès que la ligne est libre.',
  ),
  offUnconfirmed: both(
    'Off sent, without confirmation yet: held, sent again in 10 s if it got no answer or a read still shows the device on.',
    'Arrêt envoyé, sans confirmation pour l’instant : gardé, renvoyé dans 10 s s’il n’a pas eu de réponse ou si une lecture montre encore l’appareil allumé.',
  ),
};
