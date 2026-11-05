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

## Decisions

- Version 0.1.0 set by hand (package.json, lock, manifest, docker_image).
- Reference: pydeako 0.6.0 (MIT, Deako, last commit 2024-12-05) and
  local-integrations API.md 1.5 (MIT, Deako); licences read; ported to
  JavaScript, notices in `THIRD_PARTY_NOTICES.md`.
- No mDNS discovery: the address of the Connect is typed (a container often
  sees no multicast); the docs say how to find it.
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

- [ ] First test with a real Deako Connect (forum): port, message framing, EVENT
      after a CONTROL, DEVICE_BUSY frequency, the newer switches without local API.
- [ ] mDNS discovery of `_telnet._tcp` `local-integration` when the container
      sees multicast.
- [ ] `keywords` / `countries` (US) once `gladys_version` >= 5.3.0 is fine.
