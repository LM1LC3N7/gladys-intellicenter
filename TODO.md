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

## Decisions

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
  "1"). Every stop goes on a new connection (an idle one may be half-open).
  Tried every 250 ms for 3 s, then kept in `/data` and checked every 15 s and
  at every read (follow-up reads 5 and 20 s after a write included): a stop
  the panel accepted (200) without effect is written 3 more times, then held
  until a new click, the panel showing it, or a newer command of the same
  setting that left (200 or no answer; a refusal keeps the stop). A refusal
  (code other than 200), a silence or a cut never count as a write. At a
  restart, the stops not held are sent at once to their address (from
  `/data`); held ones only checked. A command sent less than 30 s before the
  stop is watched for (the stop written again if it lands).
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
  featured ones (`FEATR` ON). A circuit group featured is a circuit
  ("circuits and pumps").
- **Mutation check** (2026-10-29): 46 mutants of the guards (seq of the
  stops, options on arrival and in `beforeSend`, deadline, heating side
  effect, stop in progress, identity, read back, resend counts, hold, wait,
  watch, retries within 3 s, new connection, /data bounded wait, boot, read
  begun before a write, never sooner, freshness, check yielding, line bound,
  messageID, close before reject, strict options, /data repair), all killed
  but one equivalent (the `getConfig` retry timer rewritten in place).
- **Test files**: `test/kit/` holds gladys-testkit files as is (excluded from
  Prettier).
