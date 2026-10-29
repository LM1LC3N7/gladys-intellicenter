# gladys-intellicenter

[Gladys Assistant](https://gladysassistant.com) external integration for
**Pentair IntelliCenter** pool panels through their local protocol (TCP port
6681, JSON lines): bodies (water temperature, heating set point, heat mode,
heating now), circuits and lights, pumps (running, rpm, power), temperature
sensors, IntelliChem (pH, ORP) and IntelliChlor (salt); turning off held back
by no option, read nor command; turning on and heating behind off-by-default
options, a spa never above 40 °C. **Never tested with a real panel. Not
affiliated with Pentair.**

User documentation: [docs/en.md](docs/en.md) · [docs/fr.md](docs/fr.md).

## How it works

```
Gladys ⇄ SDK ⇄ src/handlers.js ⇄ src/app.js (IntelliCenterApp)
                                  ├─ src/lane.js        one request at a time (the stop first)
                                  ├─ src/ic/client.js   the only network access: one TCP connection, JSON lines, bounded
                                  ├─ src/ic/model.js    the answers read by name, units, set point bounds (pure)
                                  ├─ src/devices.js     the device and its states (pure)
                                  ├─ src/publisher.js   states within 300/min, nothing older than 2 min
                                  └─ src/store.js       /data/intellicenter-state.json (stops, last read; no secret)
```

- **Protocol** (as pyintellicenter 0.3.2): `GetParamList` of the system
  (`PROPNAME`, `VER`, `MODE`, `SNAME`) and of every object (`INCR`), and
  `SETPARAMLIST` for the writes. No `RequestParamList` subscription: the
  `NotifyList` lines are skipped.
- **Reads**: every 30 s (15 s – 10 min), never sooner (button, scan,
  reconnection, restart: the time of the last read is in `/data`) but the
  reads 5 and 20 s after a command; failures retried after 30 s, 1, 2, 5 min,
  never under the interval.
- **Device**: `ext:<selector>:intellicenter:<id>`, `id` a hash of the system
  `SNAME`; features `<kind>-<objnam>`, kept even when the panel no longer
  shows the object.
- **Stops** (a circuit `STATUS` OFF, a body heat `MODE` 1): never behind an
  option, a read, a command or the configuration; on a new connection; kept
  in `/data` until seen applied, checked every 15 s and at every read,
  written again 3 times at most (writes the panel accepted), never let go by
  time.
- **Commands** (a circuit on, a heat source, a set point): behind
  `allow_circuits`, `allow_lights`, `allow_heating` (off), checked again in
  `beforeSend`, decided on a fresh read, set points bounded on the degree
  written after conversion (spa 40 °C, pool the ceiling), several in one
  write, confirmed by a read back.

## Credits

The protocol is ported from
[pyintellicenter](https://github.com/joyfulhouse/pyintellicenter) (MIT,
JoyfulHouse Real Estate LLC, 0.3.2). See
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). Modelled on the sibling
integrations [gladys-iaqualink](https://github.com/LM1LC3N7/gladys-iaqualink)
and [gladys-warp-charger](https://github.com/LM1LC3N7/gladys-warp-charger).

## Development

```bash
npm install
npm test                                        # node --test, no network but loopback
npm run lint && npm run format:check
npm run audit                                   # npm audit --omit=dev
npm run cover                                   # cover.png, plain Node
npx github:GladysAssistant/integration-store .  # store admission checks
```

The panel is a fake behind an injected socket (`test/fixtures/fakePanel.js`,
built from pyintellicenter's mock server); `test/realclock.test.js` runs it
behind a real loopback TCP server on the real clock sped up 20 times.

## License

Apache-2.0, see [LICENSE](LICENSE).
