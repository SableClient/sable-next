// @vitest-environment happy-dom

import { render } from '@testing-library/svelte';
import { flushSync, tick } from 'svelte';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import type { SearchMetricsView } from '#src/generated/protocol';

vi.mock('$app/state', () => import('#lib/test-support/app-state.js'));
vi.mock('#lib/core/context.js');

import { core as baseCore } from '#lib/core/__mocks__/context.js';
import { preferences } from '#lib/settings/preferences.svelte.js';

const searchMetrics = vi.fn<() => Promise<SearchMetricsView>>();
const core = Object.assign(baseCore, { rpc: { search: { metrics: searchMetrics } } });

import SearchSharingStatus from './SearchSharingStatus.svelte';

const metrics: SearchMetricsView = {
  phase: 'crawling',
  documents: 1200,
  documents_loaded: 900,
  memory_bytes: 2_097_152,
  memory_budget: 67_108_864,
  disk_bytes: 1_048_576,
  disk_budget: 536_870_912,
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
  sharing: { state: 'waiting', rooms_received: 0 },
};

beforeEach(() => {
  core.session = { account_id: 'account' };
  vi.stubGlobal('RTCPeerConnection', vi.fn());
});

afterEach(() => {
  searchMetrics.mockReset();
  core.session = null;
  preferences.searchSharing = true;
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

async function settle(): Promise<void> {
  await tick();
  await Promise.resolve();
  flushSync();
}

function status(): string {
  return document.getElementById('search-sharing-status')?.textContent ?? '';
}

test('waiting explains that indexing continues when another device cannot connect', async () => {
  searchMetrics.mockResolvedValue(metrics);
  render(SearchSharingStatus);
  await settle();

  expect(status()).toContain('Waiting for another device');
  expect(status()).toContain('same network');
  expect(status()).toContain('Indexing continues if they cannot connect.');
});

test('it shows received rooms without implying that all history is indexed', async () => {
  searchMetrics.mockResolvedValue({ ...metrics, sharing: { state: 'idle', rooms_received: 4 } });
  render(SearchSharingStatus);
  await settle();

  expect(status()).toContain('No transfers running');
  expect(document.getElementById('search-sharing-received')?.textContent).toContain('4');
  expect(document.querySelector('[role="progressbar"]')).toBeNull();
});

test('unsupported browsers show that direct sharing is unavailable', async () => {
  vi.stubGlobal('RTCPeerConnection', undefined);
  searchMetrics.mockResolvedValue(metrics);
  render(SearchSharingStatus);
  await settle();

  expect(status()).toContain('Direct sharing unavailable');
});

test('disabling sharing takes precedence over stale transfer status', async () => {
  preferences.searchSharing = false;
  searchMetrics.mockResolvedValue({
    ...metrics,
    sharing: { state: 'transferring', rooms_received: 0 },
  });
  render(SearchSharingStatus);
  await settle();

  expect(status()).toContain('Off');
  expect(status()).not.toContain('Transferring history');
});

test('polling does not overlap requests and stops on unmount', async () => {
  vi.useFakeTimers();
  try {
    const pending = Promise.withResolvers<SearchMetricsView>();
    searchMetrics.mockReturnValueOnce(pending.promise);
    const component = render(SearchSharingStatus);
    flushSync();
    await vi.advanceTimersByTimeAsync(3000);
    expect(searchMetrics).toHaveBeenCalledOnce();
    pending.resolve(metrics);
    await settle();
    searchMetrics.mockResolvedValue({
      ...metrics,
      sharing: { state: 'transferring', rooms_received: 0 },
    });
    await vi.advanceTimersByTimeAsync(1000);
    await settle();
    expect(status()).toContain('Transferring history');
    expect(searchMetrics).toHaveBeenCalledTimes(2);
    component.unmount();
    await vi.advanceTimersByTimeAsync(2000);
    expect(searchMetrics).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});
