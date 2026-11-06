import { readFileSync, writeFileSync } from 'node:fs';

import type { PerfSnapshot } from '../../src/worker/perf-stats';
import { readCorePerf } from './fixtures/core-perf';
import { quietFor } from './fixtures/settle';
import { expect, test, SIGNED_OUT } from './fixtures/test';

type Budget = {
  idleTransactions: number;
  idleRequests: number;
  sessionTransactions: number;
  slowestCallMs: number;
  slowCallExemptions: string[];
  wasmMegabytes: number;
  idleWasmGrowthMegabytes: number;
};

const MEGABYTE = 1024 * 1024;

function callCount(perf: PerfSnapshot, method: string): number {
  return Object.hasOwn(perf.calls, method) ? perf.calls[method].count : 0;
}

const budget = JSON.parse(
  readFileSync(new URL('./core-perf.budget.json', import.meta.url), 'utf8')
) as Budget;

const IDLE_MS = 20_000;
const CHURN_MESSAGES = 20;

test.use({ storageState: SIGNED_OUT });
test.skip(({ browserName }) => browserName !== 'chromium', 'reads the worker through CDP');

test('the core stays within its IndexedDB and latency budget', async ({
  app,
  page,
  browser,
  bootstrap,
  guest,
  scratchRoom,
  signIn,
}, testInfo) => {
  test.setTimeout(180_000);
  const space = await bootstrap.createRoom({ name: 'Perf space', isSpace: true });
  const server = bootstrap.userId.split(':').slice(1).join(':');
  await bootstrap.addSpaceChild(space, scratchRoom.roomId);
  await bootstrap.sendStateEvent(scratchRoom.roomId, 'm.space.parent', space, {
    via: [server],
    canonical: true,
  });
  await bootstrap.invite(scratchRoom.roomId, guest.userId);
  await guest.join(scratchRoom.roomId);

  await page.setViewportSize({ width: 1280, height: 900 });
  await signIn();
  await app.openRoom(scratchRoom.roomId);
  await expect(app.composer).toBeVisible({ timeout: 30_000 });

  for (let index = 0; index < CHURN_MESSAGES; index += 1) {
    await guest.sendMessage(scratchRoom.roomId, `@${bootstrap.userId} ping ${String(index)}`, {
      'm.mentions': { user_ids: [bootstrap.userId] },
    });
  }
  await expect(page.getByRole('feed').getByText(`ping ${String(CHURN_MESSAGES - 1)}`)).toBeVisible({
    timeout: 30_000,
  });
  const beforeRename = await readCorePerf(browser);
  await guest.sendStateEvent(scratchRoom.roomId, 'm.room.member', guest.userId, {
    membership: 'join',
    displayname: 'Renamed guest',
  });
  await expect(page.getByRole('feed').getByText('Renamed guest').first()).toBeVisible({
    timeout: 30_000,
  });

  const active = await readCorePerf(browser);
  await quietFor(page, IDLE_MS);
  const settled = await readCorePerf(browser);

  const idle = {
    transactions: settled.idb.transactions - active.idb.transactions,
    requests: settled.idb.requests - active.idb.requests,
    wasmGrowthMegabytes: (settled.memory.wasmBytes - active.memory.wasmBytes) / MEGABYTE,
  };
  const wasmMegabytes = settled.memory.wasmBytes / MEGABYTE;
  const slowest = Object.entries(settled.calls).sort(([, a], [, b]) => b.maxMs - a.maxMs);
  const slowestBudgeted = slowest.find(([method]) => !budget.slowCallExemptions.includes(method));
  const idleStores = Object.fromEntries(
    Object.entries(settled.idb.stores)
      .map(([store, count]) => [store, count - (active.idb.stores[store] ?? 0)] as const)
      .filter(([, count]) => count > 0)
      .sort(([, a], [, b]) => b - a)
  );
  const report = {
    idle: { ...idle, stores: idleStores },
    wasmMegabytes,
    session: settled.idb,
    slowestCalls: slowest.slice(0, 10),
  };
  const reportPath = testInfo.outputPath('core-perf.json');
  writeFileSync(reportPath, JSON.stringify(report, null, 2));
  await testInfo.attach('core-perf.json', { path: reportPath, contentType: 'application/json' });
  console.log(
    `[core perf] idle tx=${String(idle.transactions)} req=${String(idle.requests)} session tx=${String(settled.idb.transactions)} wasm=${wasmMegabytes.toFixed(1)}MB slowest=${slowest[0]?.[0] ?? '-'}:${String(Math.round(slowest[0]?.[1].maxMs ?? 0))}ms`
  );

  expect
    .soft(idle.transactions, 'IndexedDB transactions while idle')
    .toBeLessThanOrEqual(budget.idleTransactions);
  expect
    .soft(idle.requests, 'IndexedDB requests while idle')
    .toBeLessThanOrEqual(budget.idleRequests);
  expect
    .soft(settled.idb.transactions, 'IndexedDB transactions this session')
    .toBeLessThanOrEqual(budget.sessionTransactions);
  expect
    .soft(slowestBudgeted?.[1].maxMs ?? 0, `slowest core call ${slowestBudgeted?.[0] ?? ''}`)
    .toBeLessThanOrEqual(budget.slowestCallMs);
  expect
    .soft(
      callCount(settled, 'members.list') - callCount(beforeRename, 'members.list'),
      'member list reloads after a rename'
    )
    .toBe(0);
  expect.soft(wasmMegabytes, 'core wasm memory').toBeLessThanOrEqual(budget.wasmMegabytes);
  expect
    .soft(idle.wasmGrowthMegabytes, 'core wasm memory growth while idle')
    .toBeLessThanOrEqual(budget.idleWasmGrowthMegabytes);
});
