// -----------------------------------------------------------------------------
// /data: repaired and bounded when read; only stops (a circuit off, a heat
// mode off) are kept; a count that cannot be read is 0; a stop never written
// has no resend; a date in the future counts as now.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileStore, normalizeMemory } from '../src/store.js';

const NOW = 1_800_000_000_000;
const stop = (extra) => ({
  host: '192.168.1.60',
  port: 6681,
  objnam: 'C0001',
  attr: 'STATUS',
  value: 'OFF',
  since: NOW - 1000,
  written: true,
  resends: 2,
  ...extra,
});

test('stops: only offs, repaired, deduplicated; unreadable counts are 0', () => {
  const m = normalizeMemory(
    {
      stops: [
        stop(),
        stop(),
        stop({ objnam: 'C0002', value: 'ON' }),
        stop({ objnam: 'B1101', attr: 'MODE', value: '2' }),
        stop({ objnam: 'B1101', attr: 'MODE', value: '1', resends: 'x' }),
        stop({ objnam: 'C0003', written: false, resends: 3 }),
        stop({ objnam: '../x' }),
        stop({ host: 'a b' }),
        stop({ objnam: 'C0004', since: NOW + 1e9 }),
      ],
      lastAttemptAt: NOW + 5000,
      target: { host: '192.168.1.60', port: 6681, id: 'nothex' },
    },
    NOW,
  );
  assert.deepEqual(
    m.stops.map((s) => [s.objnam, s.attr, s.value, s.resends]),
    [
      ['C0001', 'STATUS', 'OFF', 2],
      ['B1101', 'MODE', '1', 0],
      ['C0003', 'STATUS', 'OFF', 0],
      ['C0004', 'STATUS', 'OFF', 2],
    ],
  );
  assert.equal(m.stops[3].since, NOW);
  assert.equal(m.lastAttemptAt, NOW);
  assert.equal(m.target.id, null);
  assert.deepEqual(normalizeMemory('garbage', NOW), {
    target: null,
    lastAttemptAt: null,
    stops: [],
  });
});

test('the file: 0600, unreadable is not empty', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'ic-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'state.json');
  const store = fileStore(path);
  assert.deepEqual(await store.load(), { data: null });
  await store.save({ a: 1 });
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual(await store.load(), { data: { a: 1 } });
  await writeFile(path, '{oops');
  assert.deepEqual(await store.load(), { unreadable: true });
  assert.equal(await readFile(path, 'utf8'), '{oops');
});
