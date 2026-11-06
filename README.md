# gladys-deako

[Gladys Assistant](https://gladysassistant.com) external integration for
**Deako** smart light switches and dimmers (US), through the local API of the
**Deako Connect** (TCP, port 23): power, brightness, changes at the wall shown at
once. No account, no cloud. **Never tested with a real device. Not affiliated
with Deako.**

User documentation: [docs/en.md](docs/en.md) · [docs/fr.md](docs/fr.md).

## How it works

```
Gladys ⇄ SDK ⇄ src/handlers.js ⇄ src/app.js (App)
                                  ├─ src/link.js      one TCP connection, one request in flight
                                  ├─ src/protocol.js  messages, strict reading, framing
                                  ├─ src/devices.js   Deako device -> Gladys device
                                  └─ src/store.js     /data: address, pace, Offs held
```

- Full read (`DEVICE_LIST`) at connection and every poll interval; `EVENT`
  messages pushed by the Connect between.
- Commands in line, 800 ms apart (Deako API.md 1.1); Offs first, kept and sent
  again every 10 s (4 answered tries at most) until seen applied; a light turned on
  again at the wall after it is never turned off again (see the header of `src/app.js`).

Protocol: [DeakoLights/local-integrations](https://github.com/DeakoLights/local-integrations)
`API.md` 1.5 and [DeakoLights/pydeako](https://github.com/DeakoLights/pydeako) 0.6.0, both
MIT, by Deako (see [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)).

## Development

```bash
npm install
npm test
npm run lint && npm run format:check
```

Licence: Apache-2.0 (see [LICENSE](LICENSE)).
