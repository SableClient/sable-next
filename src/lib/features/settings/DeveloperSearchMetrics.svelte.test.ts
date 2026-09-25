// @vitest-environment happy-dom

import { flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

import type { SearchMetricsView } from '#src/generated/protocol';

vi.mock('$app/state', () => ({
  page: { url: { pathname: '/settings' }, params: {}, state: {} },
}));
vi.mock('#lib/core/context.js');

import { core as baseCore } from '#lib/core/__mocks__/context.js';

const core = Object.assign(baseCore, {
  searchMetrics: vi.fn<() => Promise<SearchMetricsView>>(),
});

import DeveloperSearchMetrics from './DeveloperSearchMetrics.svelte';

const metrics: SearchMetricsView = {
  phase: 'crawling',
  documents: 1200,
  capacity: 50000,
  rooms_joined: 40,
  rooms_indexed: 30,
  rooms_pending: 10,
  rooms_exhausted: 12,
  rooms_failed: 1,
  rooms_blind: 2,
  rooms_unreadable: 0,
  events_crawled: 6000,
  event_budget: 20000,
  batches: 60,
  pushbacks: 3,
  last_request_ms: 180,
  average_request_ms: 210,
  running_ms: 120_000,
};

afterEach(() => {
  vi.useRealTimers();
  core.searchMetrics.mockReset();
  core.session = null;
  document.body.innerHTML = '';
});

async function settle(): Promise<void> {
  await tick();
  await Promise.resolve();
  flushSync();
}

function row(id: string): string {
  return document.getElementById(id)?.textContent ?? '';
}

test('it shows the crawl rate and budget from the core metrics', async () => {
  core.session = { account_id: 'account' };
  core.searchMetrics.mockResolvedValue(metrics);

  const instance = mount(DeveloperSearchMetrics, { target: document.body });
  await settle();

  expect(row('search-rate')).toContain('3,000');
  expect(row('search-events')).toContain('6,000');
  expect(row('search-events')).toContain('20,000');
  expect(row('search-pushbacks')).toContain('3');

  await unmount(instance);
});

test('it keeps polling while mounted and stops once unmounted', async () => {
  vi.useFakeTimers();
  core.session = { account_id: 'account' };
  core.searchMetrics.mockResolvedValue(metrics);

  const instance = mount(DeveloperSearchMetrics, { target: document.body });
  await settle();
  expect(core.searchMetrics).toHaveBeenCalledTimes(1);

  await vi.advanceTimersByTimeAsync(2000);
  expect(core.searchMetrics).toHaveBeenCalledTimes(2);

  await unmount(instance);
  await vi.advanceTimersByTimeAsync(4000);
  expect(core.searchMetrics).toHaveBeenCalledTimes(2);
});
