# Third-party notices

This integration is licensed under the Apache License 2.0 (see `LICENSE`). It
contains logic ported from the projects below, both published by Deako, the
maker of the devices. The ported parts were rewritten in JavaScript; they are
changed from the original (another language, another structure, only what this
integration needs). None of the original code is copied as is.

## pydeako

- Project: [DeakoLights/pydeako](https://github.com/DeakoLights/pydeako)
  version 0.6.0 (commit 755c775, 2024-12-05), "a Python library for
  discovering, connecting to, and interacting with Deako smart devices on the
  local network", by Deako Lighting, MIT licence; the library of the Home
  Assistant Deako integration.
- What is ported (in `src/constants.js` and `src/protocol.js`): the request
  bodies (`transactionId`, `dst`, `src`, `type` `DEVICE_LIST`, `CONTROL`,
  `PING`), the `state` of a `CONTROL` (`power`, `dim` only when given), the
  reading of `DEVICE_FOUND` (dimmable from the capabilities, or from `dim` on
  the older local API versions) and of `EVENT` (a dimmer not always sending
  `dim`), the framing (CRLF between messages).
- Changes: rewritten in JavaScript for a Gladys external integration; one
  request in flight at a time with priorities and the 800 ms gap of the API
  documentation, answers matched by their `transactionId` and read as
  untrusted data (bounded lines, strict values); no mDNS discovery (the
  address is typed).

```
MIT License

Copyright (c) 2023 Deako Lighting

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## local-integrations

- Project: [DeakoLights/local-integrations](https://github.com/DeakoLights/local-integrations)
  (commit 4935d00, 2021-03-17), `API.md` 1.5 "Deako Telnet Integrations" and its
  `fake_device`, by Deako, Inc., MIT licence.
- What is used: the messages, their answers and errors (`DEVICE_BUSY`,
  `DEVICE_UNKNOWN`, `REQUEST_*`), port 23, the 800 ms between two messages,
  the connection flow; the test fake of `test/helpers/fakeDeako.js` follows
  the documented answers and the profile of its `fake_device` (uuids, names).

```
MIT License

Copyright (c) Deako, Inc. and its affiliates.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
