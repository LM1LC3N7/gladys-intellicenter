# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for human
contributors.

## What this is

A Gladys Assistant **external integration**: a Node.js service (Node 22+, ESM,
no build step) that runs in its own sandboxed Docker container and talks to
Gladys through
[`@gladysassistant/integration-sdk`](https://github.com/GladysAssistant/integration-sdk-js),
its only runtime dependency. It started from the official JavaScript template.
It reads and drives Pentair IntelliCenter pool panels over their local TCP
protocol (port 6681).

## Commands

```bash
npm install
npm test                                  # node --test --test-timeout=60000
node --test test/stop.test.js             # one file
node --test --test-name-pattern "held"    # tests whose name matches
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run format                            # Prettier, fix in place
npx github:GladysAssistant/integration-store .   # store admission checks
```

The CI (`.github/workflows/ci.yml`) runs `format:check`, `lint` and `test` on
Node 22 and 24, and builds the Docker image: run the three commands before
pushing.

## Architecture

```
index.js                          SDK wiring only: handlers registered before connect(), stops kept in /data sent at boot
src/handlers.js                   SDK handlers -> IntelliCenterApp (shared with the tests)
src/app.js                        polling, device, states, status, commands (batched), the stops and their checks
src/lane.js                       one request at a time; the stop first (it aborts the holder)
src/ic/client.js                  the only network access: one TCP connection, JSON lines, 1 MiB per line, beforeSend, abort
src/ic/model.js                   the answers read by name (pure): system, objects, units, set point bounds
src/devices.js                    device and states of the panel (pure); feature kinds are frozen
src/store.js                      /data/intellicenter-state.json: stops, last read, target; no secret
src/publisher.js                  states to Gladys within 300 per minute, nothing older than 2 minutes
src/config.js                     DEFAULT_CONFIG (mirrors the manifest defaults) + normalization
src/i18n.js                       English and French runtime texts
scripts/cover.mjs                 cover.png generator (plain Node, no dependency)
gladys-assistant-integration.json manifest: name, config_schema, actions, image...
docs/en.md, docs/fr.md            user documentation, re-hosted by Gladys (mandatory)
test/                             node --test, against the SDK's fake Gladys and test/fixtures/fakePanel.js
test/kit/                         gladys-testkit files, as is (clocks, loopback TCP server)
.github/scripts/release.mjs       release helpers (manifest bump, changelog), tested in test/
```

## Rules

- **External ids are forever.** Device `gladys.externalIds('intellicenter',
id)`, `id` the hash of the system `SNAME` (`panelIdOf`), never the address.
  Feature roles `<kind>-<objnam>` (`KINDS` of `src/constants.js`), the select
  values (`on`/`off`, the keys of `HEAT_MODES`), manifest keys (`host`,
  `allow_circuits`, `allow_lights`, `allow_heating`, `max_pool_setpoint`,
  `poll_interval`, `language`, the action `test_connection`).
- **The container rootfs is read-only.** Write only under `/data`. The panel
  has no credentials; never keep its name (`PROPNAME`) in `/data`.
- **Protocol from pyintellicenter (MIT) only**; nothing from screenlogicpy nor
  the Home Assistant IntelliCenter integration (both GPL-3.0). Only
  `GetParamList` and `SETPARAMLIST` are sent.
- **One request at a time on one connection** (`src/lane.js`): a new
  connection opens only once the previous one is closed.
- **The stops** (circuit `STATUS` OFF, body `MODE` 1): never behind an option,
  the bounds, a read, a command, a missing configuration; they abort what holds
  the line; a command that arrived before them and has not left gives way;
  kept in `/data` before the first byte (200 ms at most, a hung disk never
  holds them); checked every 15 s and at every read; written again 3 times at
  most (writes the panel answered 200); let go only when the panel shows them
  or a newer command of the same setting clicked in Gladys left. A stop that
  never left is never given up. Never ended by time.
- **Commands** (circuit on, heat source, set point): never a switch or a
  writable binary; refused unless their option, checked on arrival, on the
  fresh read and in `beforeSend`; a body circuit whose heat mode is not seen
  off needs heating too; set points bounded on the degree written after the
  °F conversion (spa ≤ 40 °C, pool ≤ the ceiling); confirmed only by a read
  back equal to the value asked.
- **Clocks**: monotonic for every in-memory time; the wall clock for /data only.
- **Never read sooner than the interval** (button, scan, reconnection,
  restart); only the follow-up reads after a command (5 s, 20 s).
- **Versions belong to the Release workflow** (Actions → Release). Never edit
  `version` by hand (0.1.0 was set by hand once, see TODO.md).
- **Changelog**: every user-visible change adds a line under
  `## [Unreleased]`.
- **Manifest** texts are `{ "en", "fr" }`; `test/manifest.test.js` ties the
  manifest to the code. Files are UTF-8 without BOM.
- **Style.** Prettier formats, ESLint catches mistakes. Comments explain why,
  in English. Tests never touch the network (loopback servers only).
