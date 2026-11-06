# TODO - Deako v1

Handoff document: what is done, what was decided, what comes next.

## Status

- [x] **Milestone 1** (2026-11-05): the Deako Connect over its local TCP API
      (port 23): power and brightness of switches and dimmers, EVENTs pushed
      at once, a full read every interval; Offs protective (guards in
      `/data`); a scene on many lights; Discover; "Test the connection";
      fr/en docs. Tested against a fake Connect on a virtual clock (built from
      API.md 1.5, its fake_device and pydeako 0.6.0) and a real local TCP
      server on a real clock (x20). Never tested with a real device.

- [x] **Review r1** (2026-11-05): REFUSÉ (4 importants, 7 mineurs); fixed: the Offs
      of a big scene without a deadline to leave, an Off cut behind a silent Off
      (I1); reads and pings never open a connection, the reconnection leaves the
      held Offs to the 10 s probe (I2); an Off before the configuration goes at
      once to the address of /data (I3); an EVENT "on" after the "ok" of an Off
      ends it, never undone (I4); a hung save of /data no longer stops the next
      ones (M2); docs (M3); ghost devices make room for listed ones, a device
      removed from the Connect leaves Discover (M4); status of an Off held
      without address (M5); mutants versioned (M7, `test/mutants.json`,
      `node scripts/mutants.mjs`).

## Decisions

- Version 0.1.0 set by hand (package.json, lock, manifest, docker_image).
- Reference: pydeako 0.6.0 (MIT, Deako, last commit 2024-12-05) and
  local-integrations API.md 1.5 (MIT, Deako); licences read; ported to
  JavaScript, notices in `THIRD_PARTY_NOTICES.md`.
- No mDNS discovery in 0.1: the address of the Connect is typed; the docs say
  how to find it. The SDK 0.16 mediated discovery (`network_discovery` mdns
  `_telnet._tcp`, `scanNetwork('mdns')`, as gladys-lutron) is for 0.2 (Next).
- Offs have no deadline to leave (only their answer is awaited 2 s once sent);
  the ack is given at 4.3 s ("waiting in line" when still queued). An Off silent
  for 1 s is cut when another Off waits behind it.
- Only an Off or a command opens a connection; reads and pings waiting fail when
  it closes. The reconnection timer leaves the held Offs to the probe (every
  10 s), so a Connect whose single slot is taken is tried every 10 s at most.
- An EVENT after the "ok" of an Off ends its guard: off = done; on = turned on
  at the wall or in the app after the Off, never undone. Only a read that left
  2 s after the "ok", no EVENT since, showing on, sends it again.
- Identity: the uuid of each device (DEVICE_FOUND); the Connect checks it on
  every CONTROL (DEVICE_UNKNOWN). Over TCP the Connect gives no serial of its
  own, so a changed address is trusted (an Off goes there whatever answers).
- One connection, one request in flight, priorities Off > command > read; 800 ms
  between two non-protective messages (API.md 1.1); an Off skips the gap and
  cuts a request without a byte for 1 s; the next connection waits for the
  closed one (200 ms at most).
- Confirmation: the "ok" of a CONTROL means "being processed"; done only once an
  EVENT after that "ok" shows the state asked. A read that left before a command
  or an EVENT of the device never applies after them.
- Non-protective commands that cannot leave by the 3.5 s ack (a scene: 800 ms
  each) stay in line up to 30 s and are said "waiting in line" (a scene goes on
  after an error of an action in Gladys).
- Offs: a try counts only once answered (ok, or an error but DEVICE_BUSY); not
  sent, no answer, cut or DEVICE_BUSY: sent again every 10 s without end; 4
  answered tries at most, then held without resend (status), a click starts
  again. An Off accepted before a restart is judged by a read, not resent.
- Before the configuration is read, the connection (to the address in /data)
  serves the Offs held only; no read.
- Brightness 0 is an Off; brightness 1-100 sends `power: true` with `dim`.
- No unit on the brightness feature: the core lists none for the light category.
- Manifest: no `keywords` / `countries` yet (they need Gladys 5.3.0); category
  `lighting`.

## Next

- [ ] 0.2: mDNS discovery through the SDK (review r1, M6): an IP that changes in
      DHCP cuts the integration until the address is typed again.
- [ ] Real firmware order (review r1, M1): an EVENT before the "ok", or a device
      already in the state asked (no EVENT), gives "sent, without confirmation";
      accept an EVENT that left after the send if a real Connect shows it.

- [ ] First test with a real Deako Connect (forum): port, message framing, EVENT
      after a CONTROL, DEVICE_BUSY frequency, the newer switches without local API.
- [ ] mDNS discovery of `_telnet._tcp` `local-integration` when the container
      sees multicast.
- [ ] `keywords` / `countries` (US) once `gladys_version` >= 5.3.0 is fine.
