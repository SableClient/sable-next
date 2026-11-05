// @vitest-environment happy-dom

import { render } from '@testing-library/svelte';
import { flushSync, tick } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

import type { SearchMetricsView } from '#src/generated/protocol';

vi.mock('$app/state', () => import('#lib/test-support/app-state.js'));
vi.mock('#lib/core/context.js');

import { core as baseCore } from '#lib/core/__mocks__/context.js';

const searchMetrics = vi.fn<() => Promise<SearchMetricsView>>();
const core = Object.assign(baseCore, { rpc: { search: { metrics: searchMetrics } } });

import SearchBackupStatus from './SearchBackupStatus.svelte';

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
  backup: {
    state: 'limit_reached',
    published_bytes: 50 * 1024 * 1024,
    limit_bytes: 100 * 1024 * 1024,
    rooms_published: 12,
    rooms_imported: 3,
    progress: null,
    next_run_ms: null,
    failures: 0,
  },
};

afterEach(() => {
  searchMetrics.mockReset();
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

test('it shows why sharing stopped and how much storage it uses', async () => {
  core.session = { account_id: 'account' };
  searchMetrics.mockResolvedValue(metrics);

  render(SearchBackupStatus);
  await settle();

  expect(row('search-backup-status')).toContain('Storage limit reached');
  expect(row('search-backup-usage')).toContain('50');
  expect(row('search-backup-usage')).toContain('100');
  expect(row('search-backup-shared')).toContain('12');
  expect(row('search-backup-received')).toContain('3');
});

test.each(['uploading', 'downloading'] as const)(
  'it shows %s progress for the current room',
  async (activity) => {
    core.session = { account_id: 'account' };
    searchMetrics.mockResolvedValue({
      ...metrics,
      backup: {
        ...metrics.backup,
        state: 'working',
        progress: {
          activity,
          room: 'Community room',
          parts_done: 2,
          parts_total: 4,
          transferred_bytes: 2_097_152,
          total_bytes: activity === 'downloading' ? 4_194_304 : null,
        },
      },
    });
    render(SearchBackupStatus);
    await settle();

    expect(row('search-backup-status')).toContain(
      activity === 'uploading' ? 'Uploading index' : 'Downloading index'
    );
    expect(row('search-backup-progress')).toContain('Community room');
    expect(row('search-backup-progress')).toContain('2 of 4 parts · 50%');
    expect(row('search-backup-progress')).toContain('2.0 MiB');
    expect(document.querySelector('[role="progressbar"]')).toHaveAttribute('aria-valuenow', '50');
    if (activity === 'downloading') expect(row('search-backup-progress')).toContain('4.0 MiB');
  }
);

test('preparation shows an indeterminate progress bar', async () => {
  core.session = { account_id: 'account' };
  searchMetrics.mockResolvedValue({
    ...metrics,
    backup: {
      ...metrics.backup,
      state: 'working',
      progress: {
        activity: 'preparing',
        room: 'Community room',
        parts_done: 0,
        parts_total: 0,
        transferred_bytes: 0,
        total_bytes: null,
      },
    },
  });
  render(SearchBackupStatus);
  await settle();

  expect(row('search-backup-status')).toContain('Preparing index');
  expect(row('search-backup-progress')).not.toContain('%');
  expect(document.querySelector('[role="progressbar"]')).toHaveAttribute('data-indeterminate');
});

test('it explains failures and shows when sharing checks again', async () => {
  core.session = { account_id: 'account' };
  const next = Date.UTC(2026, 10, 5, 12, 30);
  searchMetrics.mockResolvedValue({
    ...metrics,
    backup: { ...metrics.backup, state: 'failed', failures: 1, next_run_ms: next },
  });
  render(SearchBackupStatus);
  await settle();

  expect(row('search-backup-status')).toContain('Some transfers failed');
  expect(row('search-backup-next-check')).toContain(new Date(next).toLocaleTimeString('en'));
  expect(document.querySelector('[role="progressbar"]')).toBeNull();
});

test('it refreshes progress without overlapping requests and stops polling on unmount', async () => {
  vi.useFakeTimers();
  try {
    core.session = { account_id: 'account' };
    let resolve!: (value: SearchMetricsView) => void;
    searchMetrics.mockReturnValueOnce(
      new Promise((done) => {
        resolve = done;
      })
    );
    const component = render(SearchBackupStatus);
    flushSync();
    await vi.advanceTimersByTimeAsync(3000);
    expect(searchMetrics).toHaveBeenCalledTimes(1);
    resolve(metrics);
    await settle();
    searchMetrics.mockResolvedValue({ ...metrics, backup: { ...metrics.backup, state: 'idle' } });
    await vi.advanceTimersByTimeAsync(1000);
    await settle();
    expect(row('search-backup-status')).toContain('Up to date');
    expect(searchMetrics).toHaveBeenCalledTimes(2);
    component.unmount();
    await vi.advanceTimersByTimeAsync(2000);
    expect(searchMetrics).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});
