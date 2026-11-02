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
