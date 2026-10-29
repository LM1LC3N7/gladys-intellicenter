// -----------------------------------------------------------------------------
// The app on the REAL clock, sped up 20 times (30 s of the interval are 1.5 s,
// but it is the real clock: it moves between any two reads of it), against a
// real local TCP server answering like the fake panel: the reads really start
// at the interval, never sooner, one connection at a time, and a stop goes at
// once.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { IntelliCenterApp } from '../src/app.js';
import { memoryStore } from '../src/store.js';
import { fakePanel } from './fixtures/fakePanel.js';
import { ID } from './helpers.js';
import { measurePeriod, realClock, spyOn } from './kit/clock.mjs';
import { tcpServer } from './kit/tcp.mjs';

const SPEED = 20;
const INTERVAL = 30_000;

test('real clock x20: a read every interval, one connection at a time, a stop at once', async () => {
  const panel = fakePanel({ timers: globalThis });
  panel.objects.C0004.STATUS = 'ON';
  const server = await tcpServer({
    onData: (chunk, conn) => panel.onData(chunk, conn),
    latencyMs: 2,
  });
  const clock = realClock({ speed: SPEED });
  const gladys = createFakeGladys({ config: {} });
  await gladys.connect();
  const quiet = () => {};
  const app = new IntelliCenterApp({
    gladys,
    logger: { debug: quiet, info: quiet, warn: quiet, error: quiet },
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
    store: memoryStore(),
  });
  const spy = spyOn(app, 'run', clock);
  try {
    await app.connected({ host: `127.0.0.1:${server.port}`, poll_interval: INTERVAL / 1000 });
    const gaps = await measurePeriod(spy, { count: 3, period: INTERVAL });
    assert.equal(gaps.length, 2);
    assert.ok(server.peak <= 1, `${server.peak} connections at once`);
    assert.equal(gladys.fake.connectionStatus.connected, true);
    const started = clock.monotonic();
    await app.setValue(
      undefined,
      {
        external_id: `ext:test-integration:intellicenter:${ID}:circuit-C0004`,
      },
      'off',
    );
    assert.equal(panel.objects.C0004.STATUS, 'OFF');
    assert.ok(clock.monotonic() - started < 4_300, 'within the ack budget');
    assert.ok(server.peak <= 1);
  } finally {
    spy.restore();
    await app.shutdown();
    clock.close();
    await server.close();
  }
  assert.ok(clock.timersSet < 400, `${clock.timersSet} timers`);
});
