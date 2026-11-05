# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration** for Deako smart switches and
dimmers, through the local API of the Deako Connect (TCP, port 23, one JSON
message per line): a Node.js service (Node 22+, ESM, no build step) in its own
sandboxed Docker container, talking to Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
its only runtime dependency. Protocol: `DeakoLights/local-integrations`
`API.md` 1.5 and `DeakoLights/pydeako` 0.6.0 (both MIT, see
`THIRD_PARTY_NOTICES.md`).

## Commands

```bash
npm install
npm test                                  # node --test --test-timeout=60000
node --test test/off.test.js              # one file
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
node scripts/cover.mjs cover.png          # the store cover (800x534)
```

## Architecture

```
index.js              SDK wiring only (src/handlers.js registers the handlers before connect())
src/app.js            the session: connection, full reads, EVENTs, commands, Offs held, status
src/link.js           the TCP connection: one request in flight, priorities, 800 ms gap, cut
src/protocol.js       the messages (pure): requests, strict reading, line framing
src/devices.js        a Deako device -> its Gladys device (pure)
src/store.js          /data: the address, the time of the last full read, the Offs held
src/config.js         the configuration (address, interval, language)
src/publisher.js      states to Gladys within 300 per minute
src/i18n.js           texts in English and French
test/                 node --test: fake Connect on a virtual clock, real TCP on a real clock (x20)
```

## Rules

- **External ids are forever**: `ext:<selector>:light:<uuid>` with the uuid the
  Connect gives the device; feature keys `power`, `brightness`.
- **An Off is never held back** (see the header of `src/app.js`): any change on
  its path keeps a test that kills its mutant; no test may hang (every wait
  bounded).
- **Order**: a full read that left before a command or an EVENT of a device
  never applies its state after them (`tick` / `mark`).
- **Two clocks**: `monotonic` for every decision, `now` for /data only.
- **The container rootfs is read-only**: write only under `/data`.
- **Versions belong to the Release workflow**; `CHANGELOG.md` under
  `## [Unreleased]`; user-facing text in English and French, docs in sync.
