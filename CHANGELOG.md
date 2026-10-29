# Changelog

All notable changes to this integration are documented in this file. The format
follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project
uses [semantic versioning](https://semver.org/).

Describe each change under `## [Unreleased]` as you make it. The Release
workflow moves that section under the version it ships, and the section becomes
the notes of the version's GitHub Release.

## [Unreleased]

### Added

- Pentair IntelliCenter pool panels read over their local protocol (TCP port
  6681, no cloud, no credentials): one device per panel, keyed by its system
  name.
- Bodies (water temperature while running, heating set point, heat mode,
  heating now), circuits and lights (on / off lists), pumps (running, rpm,
  power), temperature sensors, IntelliChem (pH, ORP and their set points, read
  only) and IntelliChlor (salt); °F converted exactly to °C.
- Turning a circuit off and setting a heat mode to Off never held back
  (options, reads, commands, configuration not read, restart), kept in `/data`
  until seen applied, written again 3 times at most.
- Turning circuits and pumps on, lights on, and heating (heat source, set
  point) behind three options, off by default; a spa never above 40 °C, a pool
  never above its ceiling (35 °C by default), on the degree written.
- "Test the connection" button, docs in English and French.
- A heating stop is confirmed only once the body no longer heats; the status
  says when the mode Off is shown while it still heats. Circuit groups need
  the heating option. Stops kept for several addresses are each checked;
  refused stops are written again less and less often (up to every 5 min).
- A slow /data is applied when its read ends (its kept stops sent); a body
  still reporting heating counts as heating; a command never waits behind a
  check of the stops.
