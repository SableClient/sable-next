// @vitest-environment happy-dom

import { render } from '@testing-library/svelte';
import { flushSync, tick } from 'svelte';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import type { CoreEvent, SearchMetricsView, SearchSharingView } from '#src/generated/protocol';

vi.mock('$app/state', () => import('#lib/test-support/app-state.js'));
vi.mock('#lib/core/context.js');

import { core as baseCore } from '#lib/core/__mocks__/context.js';
import { preferences } from '#lib/settings/preferences.svelte.js';

const searchMetrics = vi.fn<() => Promise<SearchMetricsView>>();
const peerFind = vi.fn(() => Promise.resolve(null));
const peerReset = vi.fn(() => Promise.resolve(null));
const unsubscribe = vi.fn();
let listener: ((event: CoreEvent) => void) | undefined;
const core = Object.assign(baseCore, {
  rpc: { search: { metrics: searchMetrics, peerFind, peerReset } },
  subscribeEvents(callback: (event: CoreEvent) => void) {
    listener = callback;
    return unsubscribe;
  },
});

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
  sharing: idle(),
};

function idle(overrides: Partial<SearchSharingView> = {}): SearchSharingView {
  return {
    state: 'idle',
    pause: null,
    outcome: null,
    peer: null,
    rooms_copied: 0,
    last_copy: null,
    automatic: false,
    asked: 0,
    candidates: [],
    ...overrides,
  };
}

function withSharing(overrides: Partial<SearchSharingView>): SearchMetricsView {
  return { ...metrics, sharing: idle(overrides) };
}

beforeEach(() => {
  core.session = { account_id: 'account' };
  vi.stubGlobal('RTCPeerConnection', vi.fn());
});

afterEach(() => {
  searchMetrics.mockReset();
  peerFind.mockClear();
  peerReset.mockClear();
  unsubscribe.mockClear();
  listener = undefined;
  preferences.developerTools = false;
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

test('a new device explains when history is copied and offers to copy now', async () => {
  searchMetrics.mockResolvedValue(metrics);
  render(SearchSharingStatus);
  await settle();

  expect(status()).toContain('Ready');
  expect(status()).toContain('after you verify this one');
  const button = document.querySelector<HTMLButtonElement>('#search-sharing-find button');
  button?.click();
  await settle();
  expect(peerFind).toHaveBeenCalledOnce();
});

test('the reset button forgets what this device received', async () => {
  searchMetrics.mockResolvedValue(
    withSharing({ last_copy: { device_id: 'PHONE', name: null, at_ms: 0, rooms: 3 } })
  );
  render(SearchSharingStatus);
  await settle();

  document.querySelector<HTMLButtonElement>('#search-sharing-reset button')?.click();
  await settle();
  expect(peerReset).toHaveBeenCalledOnce();
});

test('the pause reason replaces the waiting state', async () => {
  searchMetrics.mockResolvedValue(withSharing({ pause: 'metered', outcome: 'no_answer' }));
  render(SearchSharingStatus);
  await settle();

  expect(status()).toContain('Paused');
  expect(status()).toContain('cellular or Low Data Mode');
  expect(document.querySelector<HTMLButtonElement>('#search-sharing-find button')?.disabled).toBe(
    true
  );
});

test('progress names the device being copied from', async () => {
  searchMetrics.mockResolvedValue(
    withSharing({
      state: 'receiving',
      peer: { device_id: 'MAC', name: 'MacBook' },
      rooms_copied: 3,
    })
  );
  render(SearchSharingStatus);
  await settle();

  expect(status()).toContain('Copying from MacBook, 3 rooms so far');
});

test('an unanswered automatic copy says it asks again next time', async () => {
  searchMetrics.mockResolvedValue(withSharing({ outcome: 'no_answer', automatic: true }));
  render(SearchSharingStatus);
  await settle();

  expect(status()).toContain('asks again the next time it opens');
});

test('a busy device is waited for by name', async () => {
  searchMetrics.mockResolvedValue(
    withSharing({ state: 'waiting', peer: { device_id: 'MAC', name: 'MacBook' } })
  );
  render(SearchSharingStatus);
  await settle();

  expect(status()).toContain('Waiting');
  expect(status()).toContain('MacBook is copying with another device');
});

test('the last copy stays visible', async () => {
  searchMetrics.mockResolvedValue(
    withSharing({
      outcome: 'completed',
      last_copy: { device_id: 'PHONE', name: null, at_ms: 0, rooms: 2 },
    })
  );
  render(SearchSharingStatus);
  await settle();

  expect(status()).toContain('up to date');
  expect(document.getElementById('search-sharing-last-copy')?.textContent).toContain(
    '2 rooms from PHONE'
  );
});

test('developer tools list every candidate with its index size', async () => {
  preferences.developerTools = true;
  searchMetrics.mockResolvedValue(
    withSharing({
      asked: 3,
      candidates: [
        {
          device_id: 'MAC',
          name: 'MacBook',
          documents: 1200,
          complete_rooms: 4,
          status: 'failed',
        },
      ],
    })
  );
  render(SearchSharingStatus);
  await settle();

  expect(document.getElementById('search-sharing-asked')?.textContent).toContain('3');
  expect(document.body.textContent).toContain('MacBook');
  expect(document.body.textContent).toContain('1,200 messages, 4 full rooms, Failed');
});

test('unsupported browsers show that direct sharing is unavailable', async () => {
  vi.stubGlobal('RTCPeerConnection', undefined);
  searchMetrics.mockResolvedValue(metrics);
  render(SearchSharingStatus);
  await settle();

  expect(status()).toContain('Unavailable');
  expect(document.getElementById('search-sharing-find')).toBeNull();
});

test('disabling sharing takes precedence over stale transfer status', async () => {
  preferences.searchSharing = false;
  searchMetrics.mockResolvedValue(withSharing({ state: 'receiving' }));
  render(SearchSharingStatus);
  await settle();

  expect(status()).toContain('Off');
  expect(status()).not.toContain('Copying');
});

test('pushed sharing events replace the fetched status until unmount', async () => {
  searchMetrics.mockResolvedValue(metrics);
  const component = render(SearchSharingStatus);
  await settle();
  expect(status()).toContain('Ready');

  listener?.({
    type: 'search_sharing',
    sharing: idle({ state: 'sending', peer: { device_id: 'PHONE', name: 'Phone' } }),
  });
  await settle();
  expect(status()).toContain('Sending search history to Phone');
  expect(searchMetrics).toHaveBeenCalledOnce();
  component.unmount();
  expect(unsubscribe).toHaveBeenCalledOnce();
});
