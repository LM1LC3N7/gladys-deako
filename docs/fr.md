# Deako

Intègre à Gladys les **interrupteurs et variateurs connectés Deako** par l’API
locale du **Deako Connect**, sans compte ni cloud : marche / arrêt et intensité,
et les changements faits au mur ou dans l’application Deako affichés aussitôt.

> Jamais testé avec un vrai appareil : dites-nous sur le forum comment ça se
> passe. Sans lien avec Deako.

## Avant de commencer

- Vos interrupteurs sont installés avec l’application Deako et un **Deako
  Connect** (ou un interrupteur Deako qui sert de passerelle) est sur votre
  réseau. Les interrupteurs Deako les plus récents n’ont pas d’API locale : ils
  ne sont pas joignables ainsi.
- Donnez au Connect une adresse IP fixe dans votre box. Il s’annonce sur le
  réseau comme le service `local-integration` (`_telnet._tcp`) ; votre box
  affiche aussi son adresse.

## Configuration

1. **Adresse du Deako Connect** : son adresse IP (ou son nom), avec `:port`
   seulement si ce n’est pas le 23.
2. **Lecture complète toutes les** : fréquence de relecture de toute la liste
   des appareils (60 s par défaut, 30 s au moins). Les changements arrivent
   aussitôt entre deux (le Connect les envoie).
3. Enregistrez, puis ouvrez **Découverte** : chaque interrupteur et variateur y
   est listé avec son nom dans l’application Deako. Ajoutez ceux que vous
   voulez.

**Tester la connexion** ouvre la connexion si elle est fermée (au plus toutes
les 10 s) et vérifie que le Connect répond.

## Appareils

| Appareil Deako | Fonctionnalités                                   |
| -------------- | ------------------------------------------------- |
| Interrupteur   | Allumage (0 / 1)                                  |
| Variateur      | Allumage (0 / 1), intensité (0 à 100, 0 = éteint) |

## Envoi des commandes

- Un message à la fois, à 800 ms d’écart (comme Deako le demande). Une commande
  est faite quand le Connect montre le nouvel état ; sinon son message dit
  pourquoi (« envoyée, sans confirmation », « refusée par le Connect »…), et
  les appareils sont relus 5 s plus tard.
- Une scène sur plusieurs lumières les règle toutes : les commandes attendent
  en file (30 s au plus), celles d’un même appareil fusionnées. Gladys reçoit
  sa réponse sous 3,5 s : une commande encore en file dit alors « en file » et
  part quand même.

## Extinction (arrêt)

Un arrêt (allumage 0, ou intensité 0) ne demande aucune option et passe en
premier : avant les commandes en attente (il annule celles du même appareil),
sans l’écart de 800 ms, en coupant une requête restée 1 s sans réponse, même
avant la lecture de la configuration (vers l’adresse de la dernière session).

S’il ne peut pas partir (le Connect ne répond pas), il est **gardé** (même après
un redémarrage) et renvoyé toutes les 10 s et dès le retour de la connexion. Il
prend fin quand l’appareil se montre éteint, quand une commande plus récente de
cet appareil part, ou quand l’appareil est supprimé.

Un arrêt n’est refusé que si l’adresse du Connect n’est pas connue (aucune
saisie, aucune d’une session précédente), ou remplacé par un clic plus récent
sur le même appareil avant de partir. Quand le Connect y a répondu 4 fois
(accepté ou refusé, « occupé » non compté) sans que l’appareil se montre éteint,
il n’est plus renvoyé de lui-même : le statut le dit ; recliquez sur Arrêt.

## Statut

La page Configuration montre la connexion, le nombre d’appareils, ceux à
ajouter et chaque arrêt gardé.

## En cas de problème

- « injoignable » : vérifiez l’adresse et que le Connect est sur le même réseau
  que Gladys ; nouveaux essais après 5 ou 15 s, puis 30 s, 1, 2, puis toutes les 5 minutes.
- Rien dans Découverte : vérifiez dans l’application Deako que les
  interrupteurs appartiennent au profil de ce Connect.
