# TODO — Pentair IntelliCenter v1

Handoff document: what is done, what was decided, what comes next. Keep it
up to date at the end of every milestone.

## Working method

- One milestone at a time, one commit per milestone, tests green before moving on.
- After each milestone: `gi ci` (Prettier, ESLint, Node 22 and 24, Docker,
  store validator), `npm run audit`, then update README, `docs/en.md`,
  `docs/fr.md`, `CHANGELOG.md` and this file.
- No forum post from a module session: the batch reserved in /t/10385
  (lot 18) gets one recap message there.
- The `gladys-assistant-integration` topic is added at the first real release
  only. No `keywords` nor `countries` in the manifest yet (the core has not
  shipped them).

## Status

- [x] **Milestone 1 — core** (2026-10-29): one panel by address, one device
      per panel (hash of `SNAME`), bodies, circuits, lights, pumps, sensors,
      IntelliChem, IntelliChlor; stops never held back (kept in `/data`,
      checked every 15 s, 3 resends at most, watched for a late command);
      circuits, lights and heating behind three options; set points bounded
      after the °F conversion; commands batched (a scene in one write);
      never read sooner than the interval; docs en/fr, cover. Tested against
      a fake built from pyintellicenter only.
- [ ] **Milestone 2 — real panel**: run against a real IntelliCenter (see
      "To check"), turn the answers (anonymized) into fixtures.
- [ ] **Milestone 3 — more**: `RequestParamList` / `NotifyList` (pushed
      changes instead of polling, bounded), pump speeds (`PMPCIRC`), light
      shows, the chemistry set points as commands (behind an option), the
      body volume (gallons converted to litres), the cooling set point
      (`HITMP`) of UltraTemp heat pumps, superchlorination.

## To check on a real panel

- Heat off: `MODE` = "1" on the body (pyintellicenter `HeaterType.OFF`); does
  the panel show `MODE` "1" right after, and does it stop the heater? Some
  firmware may rather use the body `HEATER` attribute ("00000").
- The system object of `condition: "OBJTYP=SYSTEM"` (its objnam, `SNAME`
  stable across reboots and firmware updates).
- A `GetParamList` with a list of objnams (without `condition`), and what an
  unknown objnam answers.
- The answer of a refused `SETPARAMLIST` (code), and of a write to an object
  that does not exist.
- `TEMP` of a body while its circuit is off; `HTMODE` values; `STATUS` of a
  pump ("10" / "4"); pH, ORP and salt at 0 when the IntelliChem is idle.
- Whether the panel accepts several TCP clients (the Pentair app, Home
  Assistant) and closes idle connections; the time a write takes to show.
- Which circuits a user expects (FEATR ON, the `SHOMNU` permissions).
- A featured circuit tied to a body (`BODY`, sub-type GENERIC, "Spa Jets"):
  treated as a plain circuit, accepted without the heating option while its
  body heats. Does turning it on start its body (and its heating)?
- `LOTMP` is the set point the heater aims at: pyintellicenter also names
  `SETPT` ("same as LOTMP") and `SETTMP` ("used by some systems"). If a
  firmware heats to another, the bounded write and the held set point check
  both miss.

## Decisions

- **Held set point (2026-10-31, after the OmniLogic r1 I1)**: a heat source,
  a body circuit that heats and a circuit group while a body heats are
  refused when the `LOTMP` its body holds, on the fresh read, is above the
  body's ceiling (pool: the configuration, spa: 40 °C; whole degree, °F
  rounded down) or unreadable (a body circuit whose body is unknown, a group
  with no body read, the unit unknown). Checked after the options (an option
  off says so first) and before "already so" (a source already selected
  above the ceiling is still refused). Said in the ack and in the status
  until a read shows it within the ceiling, 15 min at most. Stops never
  checked. Pumps take no command here (only circuits). Review r1 of the fix:
  I1 test for a group whose second heating body (the spa) is above; m1 the
  note kept under the body (a circuit or group key only when no body is
  known, cleared by the read that knows it); m2 a scene lowering the set point
  and choosing a source: the source refused, documented and tested (deciding
  on the batch's own write was not chosen: the read is the evidence); m3 two
  points to check on a real panel. The manifest test no
  longer pins 0.1.0 (it failed since the 0.1.1 release).

- **Review r3 (2026-10-29)**: I1 tests for a command never taking the line
  from a stop (only from a check), a late /data never replacing a stop of
  this run, a body circuit of no known body refused during a heat stop. m1 a
  stop of /data (clicked before the restart) is let go, unsent, when a
  command of its setting left in this run without a refusal (200 or no
  answer, as for a kept stop), at boot or when /data is read late; /data
  then forgets it; a stop let go while it waited for the line is not
  written (checked again in `beforeSend`); the stops of a late /data follow
  the same panel (same id) to the address read in this run. m2 tests for the
  answer of a stop found by its setting and a check cut by a command tried
  again a second later. Every mutant of the reviewer (R2, R6, R8, R9, R11)
  and of these guards killed.

- **Review r2 (2026-10-29)**: B1 a /data load slower than 2 s is no longer
  dropped: nothing waits for it past 2 s, and when it ends it is applied
  (its stops kept and the unheld sent, `target` and `lastAttemptAt` taken,
  writes allowed again); only a read error or invalid JSON is unreadable.
  I1 a body circuit heats while its heat mode is not seen "1" or `HTMODE`
  is not 0 (unreadable = heats), and is refused during the heat stop of its
  body whatever is read (groups: any heat stop). I2 tests for groups during a
  heat stop and before any read. m1 an unreadable `HTMODE` said as such in the
  status. m2 a command takes the line from a check of the stops (a dead old
  address never makes a command miss its turn). m3 the answer of a stop is
  found by its setting, not by an address that may change meanwhile.

- **Review r1 (2026-10-29)**: B1 one check per address (the stops of an old
  address looped, those of the new one were never written; the same panel at
  a new address takes its stops along). I1 a stop written again at most every
  15 s (follow-up reads no longer rewrite it, the checks arm no follow-up),
  refusals spaced up to 5 min. I2 heat stop applied only with `HTMODE` 0.
  I3 circuit groups behind heating. I4 tests for the bounded /data wait of
  the stop, the °F ceiling rounded down, the stop first on the line. m1 the
  status says "refused (code)"; m2 /data bounded (load 2 s, saves 2 s), a stop
  clicked without an address kept and sent first; m3 a failed save of the
  stops tried again. Reviewer mutants M2 and M24 left: equivalent (as r1 said).

- **Version 0.1.0 set by hand** in `package.json`, `package-lock.json`, the
  manifest and the `docker_image` tag
  (`ghcr.io/lm1lc3n7/gladys-intellicenter:0.1.0`): the first Release (patch)
  gives 0.1.1. SDK `^0.16.0` (latest published, checked 2026-10-29 on the
  registry; changelog read: nothing this module relies on changed).
- **Reference**: pyintellicenter 0.3.2 (MIT, `a8c6cb8` of 2026-10-26), cloned
  read only in `~/code/ref/lot18/pyintellicenter`. The Home Assistant
  integration joyfulhouse/intellicenter is GPL-3.0: its clone was removed
  unread. screenlogicpy (GPL-3.0) and ScreenLogic are out of scope.
- **Categories** `appliances`, `environment` (as gladys-iaqualink and
  gladys-fluidra-pool).
- **Polling only** (no `RequestParamList`): two requests per read (the system,
  then every object with 19 keys). A line is at most 1 MiB, cut as it
  arrives; 200 lines that are not the answer at most per request; 1000
  objects, 64 per kind. The connection is closed after 20 s idle; a closed
  connection waits for the panel's side (FIN, 300 ms at most) before a new
  one.
- **The stops**: a circuit off (`STATUS` OFF) and a heat mode off (`MODE`
  "1", applied only when `HTMODE` reads 0). Every stop goes on a new
  connection (an idle one may be half-open). Tried every 250 ms for 3 s,
  then kept in `/data` and checked every 15 s, each address on its own check
  (the stops of an old address never hold back those of the new one), and
  at every read: a stop the panel accepted (200) without effect is written
  again 15 s after each write, 3 times at most, then held until a new click,
  the panel showing it, or a newer command of the same setting that left
  (200 or no answer; a refusal keeps the stop). A refusal (code other than 200) never counts as a write: written again after 15 s, 30 s, 1, 2, 4 min,
  then every 5 min, without end. A silence or a cut never count either; a
  stop that never left is tried at every check and every read that reaches
  the panel. The checks arm no follow-up read. At a restart, the stops not
  held are sent at once to their address (from `/data`); held ones only
  checked. The same panel (same id) read at a new address takes its kept
  stops along. A stop clicked while no address is known is kept in memory
  and sent first once one is. A command sent less than 30 s before the stop
  is watched for (the stop written again if it lands).
- **Heat stop and `HTMODE`**: `MODE` "1" comes from pyintellicenter
  (`HeaterType.OFF`), whose own changelog says heater actuation is not
  validated. So the heat stop is "applied" only when `MODE` is "1" and
  `HTMODE` is 0 (`is_body_heating`); `MODE` "1" with heating still reported
  is watched (nothing written again: the mode is shown Off), said in the
  status as a cool-down for 2 minutes, then as "check on the panel". The
  body `HEATER` attribute is never written without evidence (review r1, I2).
- **/data**: a load that does not end in 2 s counts as unreadable (never
  overwritten) until it ends, then is applied; the saves on the path of a read or a start are not awaited
  more than 2 s; a save of the stops that failed is tried again (compared
  with the last one that succeeded).
- **Heating set point**: always behind "Allow heating", including a decrease
  (the protective path is the heat mode Off). Refused while the heat stop of
  its body is not seen applied (a side effect that could restart heating), as
  is turning on its body circuit when that would heat.
- **Bounds**: 4–40 °C (40–104 °F, the manufacturer's range); a spa 40 °C at
  most; a pool the configured ceiling (35 °C by default, 10–40, rounded
  down); a body of another sub-type the lower of both. Checked on the whole
  degree written after conversion (low rounded up, high rounded down), with a
  final check on the converted value.
- **Body circuit** (sub-type POOL/SPA): turning it on starts its pump and, if
  its heat mode is not seen "1", its heating: "Allow heating" needed too. The
  body is the circuit's `BODY`, else the only body of the same sub-type;
  unknown: heating needed (in doubt).
- **Commands batched**: commands arriving within 30 ms go in one
  SETPARAMLIST (one entry per object), after one fresh read (system + the
  objects + every body known); a later command of the same setting in the
  batch replaces the earlier one. Each leaves by 3.5 s after its click or
  never, answered by 4.3 s.
- **Not published**: `LSTTMP` (old water temperature), the body volume (unit
  unclear in metric mode), the saturation index (0 is valid and
  "unavailable"), pump GPM.
- **Shown circuits**: body circuits, lights (`LIGHT_SUBTYPES` + `LITSHO`) and
  featured ones (`FEATR` ON). A circuit group (`CIRCGRP`, "Spa Mode") may
  turn a body and its heating on: its members are not read, so it needs
  "Allow heating" too unless every body is seen with its heat mode "1" on the
  fresh read, and it is refused during the heat stop of any body (review r1,
  I3). Reading the `CIRCGRP` rows to narrow this is for later.
- **Mutation check** (2026-10-29): 46 mutants of the guards (seq of the
  stops, options on arrival and in `beforeSend`, deadline, heating side
  effect, stop in progress, identity, read back, resend counts, hold, wait,
  watch, retries within 3 s, new connection, /data bounded wait, boot, read
  begun before a write, never sooner, freshness, check yielding, line bound,
  messageID, close before reject, strict options, /data repair), all killed
  but one equivalent (the `getConfig` retry timer rewritten in place).
- **Test files**: `test/kit/` holds gladys-testkit files as is (excluded from
  Prettier).

## Next patch

- r4 m1 (`src/app.js:1696-1713`): when the panel moved, a stop that follows it to the new address can still
  undo a newer command (`retargetStops` ignores commands that left; s40 h and i). Safe direction, but the docs
  promise otherwise: date the commands that left and drop, unwritten, any older stop in `retargetStops` and
  `followPanel`.
- r4 m2 (`src/app.js:2068`): with HTMODE unreadable, the click answer says "still heating" while the status
  says "unreadable".
