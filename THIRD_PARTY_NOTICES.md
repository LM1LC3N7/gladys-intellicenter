# Third-party notices

This integration is licensed under the Apache License 2.0 (see `LICENSE`).

## pyintellicenter

The IntelliCenter protocol as used here (`src/constants.js`, `src/ic/client.js`,
`src/ic/model.js`) is ported from **pyintellicenter** 0.3.2
(<https://github.com/joyfulhouse/pyintellicenter>, commit `a8c6cb8` of
2026-10-26, MIT, JoyfulHouse Real Estate LLC): TCP port 6681, one JSON object
per line ended by CR LF, `messageID` and `response` "200", the
`GetParamList` and `SETPARAMLIST` commands, the system object and its
`MODE` (ENGLISH / METRIC) and `SNAME` (the unique id), a key echoed with its
own name meaning "no value", the object types and attributes (BODY, CIRCUIT,
PUMP, SENSE, CHEM; STATUS, TEMP, LOTMP, MODE, HTMODE, RPM, PWR, SOURCE,
PHVAL, ORPVAL, PHSET, ORPSET, SALT), the light sub-types, the pump status
codes and the heat modes (HeaterType). The fake panel of the tests follows
its mock server. No Python code runs here and pyintellicenter is not a
dependency. This port was modified: written in JavaScript, every read and
write bounded in time and size, one request at a time, no NotifyList
subscription, no WebSocket, no light shows, schedules nor firmware update,
stops never held back, commands behind options, set points bounded.

```
MIT License

Copyright (c) 2025-2026 JoyfulHouse Real Estate LLC

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

Nothing is taken from screenlogicpy (GPL-3.0) nor from the Home Assistant
IntelliCenter integration (GPL-3.0).

## gladys-testkit

`test/kit/` holds files of gladys-testkit (Apache-2.0), used by the tests
only (not in the image).
