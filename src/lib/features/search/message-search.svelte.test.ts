import { flushSync } from 'svelte';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import type {
  SearchCoverageView,
  SearchDirectory,
  SearchHitView,
  Rpc,
} from '#src/generated/protocol';

import type { CoreClient } from '#lib/core/client.svelte.js';

import { MessageSearch } from './message-search.svelte.js';

const directory: SearchDirectory = { rooms: [], people: [] };

function hit(eventId: string): SearchHitView {
  return {
    room_id: '!room:example.org',
    event_id: eventId,
    body: 'the deploy pipeline is broken',
    sender: '@kris:example.org',
    origin_server_ts: 1_700_000_000_000,
    score: 1,
    context_before: [],
    context_after: [],
  };
}

function page(
  hits: SearchHitView[],
  older: string | null = null
): { hits: SearchHitView[]; older: string | null } {
  return { hits, older };
}

function coverage(
  documents: number,
  state: SearchCoverageView['state'] = 'indexing'
): SearchCoverageView {
  return { documents, state, rooms_pending: state === 'indexing' ? 1 : 0, rooms_failed: 0 };
}

function coreReturning(searchMessages: Rpc['search']['messages']): {
  core: CoreClient;
  searchMessages: Rpc['search']['messages'];
} {
  return {
    core: { rpc: { search: { messages: searchMessages } } } as unknown as CoreClient,
    searchMessages,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

test('an empty query clears results without asking the core', async () => {
  const searchMessages = vi.fn().mockResolvedValue(page([hit('$a')]));
  const { core } = coreReturning(searchMessages);
  const search = new MessageSearch(core, () => directory);

  search.query = 'deploy';
  search.schedule();
  await vi.advanceTimersByTimeAsync(500);
  expect(search.hits).toHaveLength(1);

  search.query = '   ';
  search.schedule();
  await vi.advanceTimersByTimeAsync(500);

  expect(search.hits).toEqual([]);
  expect(search.searching).toBe(false);
  expect(searchMessages).toHaveBeenCalledTimes(1);
});

test('typing again before the debounce elapses searches once', async () => {
  const searchMessages = vi.fn().mockResolvedValue(page([hit('$a')]));
  const { core } = coreReturning(searchMessages);
  const search = new MessageSearch(core, () => directory);

  search.query = 'dep';
  search.schedule();
  search.query = 'depl';
  search.schedule();
  search.query = 'deploy';
  search.schedule();
  await vi.advanceTimersByTimeAsync(500);

  expect(searchMessages).toHaveBeenCalledTimes(1);
  expect(searchMessages).toHaveBeenCalledWith(
    expect.objectContaining({ query: 'deploy', order: 'recent', limit: 30, offset: 0, context: 1 })
  );
});

test('a slow response for an abandoned query never lands', async () => {
  const searchMessages = vi
    .fn()
    .mockImplementationOnce(
      async () =>
        new Promise<{ hits: SearchHitView[]; older: string | null }>((resolve) => {
          setTimeout(() => {
            resolve(page([hit('$stale')]));
          }, 1_000);
        })
    )
    .mockResolvedValueOnce(page([hit('$fresh')]));
  const { core } = coreReturning(searchMessages);
  const search = new MessageSearch(core, () => directory);

  search.query = 'stale';
  search.schedule();
  await vi.advanceTimersByTimeAsync(250);

  search.query = 'fresh';
  search.schedule();
  await vi.advanceTimersByTimeAsync(2_000);

  expect(search.hits.map((entry) => entry.event_id)).toEqual(['$fresh']);
});

test('a short page marks the results exhausted', async () => {
  const searchMessages = vi.fn().mockResolvedValue(page([hit('$a'), hit('$b')]));
  const { core } = coreReturning(searchMessages);
  const search = new MessageSearch(core, () => directory);

  search.query = 'deploy';
  search.schedule();
  await vi.advanceTimersByTimeAsync(500);

  expect(search.exhausted).toBe(true);

  await search.loadMore();
  expect(searchMessages).toHaveBeenCalledTimes(1);
});

test('a page with repeated events keeps each event once', async () => {
  const searchMessages = vi.fn().mockResolvedValue(page([hit('$duplicate'), hit('$duplicate')]));
  const { core } = coreReturning(searchMessages);
  const search = new MessageSearch(core, () => directory);

  search.query = 'deploy';
  search.schedule();
  await vi.advanceTimersByTimeAsync(500);

  expect(search.hits.map((entry) => entry.event_id)).toEqual(['$duplicate']);
});

test('a full page loads more and appends', async () => {
  const firstPage = Array.from({ length: 30 }, (_, index) => hit(`$first${String(index)}`));
  const searchMessages = vi
    .fn()
    .mockResolvedValueOnce(page(firstPage))
    .mockResolvedValueOnce(page([hit('$second')]));
  const { core } = coreReturning(searchMessages);
  const search = new MessageSearch(core, () => directory);

  search.query = 'deploy';
  search.schedule();
  await vi.advanceTimersByTimeAsync(500);
  expect(search.exhausted).toBe(false);

  await search.loadMore();

  expect(search.hits).toHaveLength(31);
  expect(searchMessages).toHaveBeenLastCalledWith(
    expect.objectContaining({ query: 'deploy', limit: 30, offset: 30 })
  );
  expect(search.exhausted).toBe(true);
});

test('a short page with messages on disk continues into older pages', async () => {
  const searchMessages = vi
    .fn()
    .mockResolvedValueOnce(page([hit('$recent')], ''))
    .mockResolvedValueOnce(page([hit('$older')], '100:3:!room:example.org'))
    .mockResolvedValueOnce(page([hit('$oldest')]));
  const { core } = coreReturning(searchMessages);
  const search = new MessageSearch(core, () => directory);

  search.query = 'deploy';
  search.schedule();
  await vi.advanceTimersByTimeAsync(500);
  expect(search.older).toBe(true);
  expect(search.exhausted).toBe(false);

  await search.loadMore();
  expect(searchMessages).toHaveBeenLastCalledWith(
    expect.objectContaining({ query: 'deploy', older: '' })
  );
  await search.loadMore();
  expect(searchMessages).toHaveBeenLastCalledWith(
    expect.objectContaining({ query: 'deploy', older: '100:3:!room:example.org' })
  );

  expect(search.hits.map((entry) => entry.event_id)).toEqual(['$recent', '$older', '$oldest']);
  expect(search.exhausted).toBe(true);
  expect(search.older).toBe(false);
});

test('an older page that finds nothing still counts as a page, so scrolling asks again', async () => {
  const searchMessages = vi
    .fn()
    .mockResolvedValueOnce(page([hit('$recent')], ''))
    .mockResolvedValueOnce(page([], '100:3:!room:example.org'));
  const { core } = coreReturning(searchMessages);
  const search = new MessageSearch(core, () => directory);

  search.query = 'deploy';
  search.schedule();
  await vi.advanceTimersByTimeAsync(500);
  const before = search.pages;

  await search.loadMore();

  expect(search.hits).toHaveLength(1);
  expect(search.pages).toBe(before + 1);
  expect(search.exhausted).toBe(false);
});

test('a failure reports itself and stops paging', async () => {
  const searchMessages = vi.fn().mockRejectedValue(new Error('core is gone'));
  const { core } = coreReturning(searchMessages);
  const search = new MessageSearch(core, () => directory);

  search.query = 'deploy';
  search.schedule();
  await vi.advanceTimersByTimeAsync(500);

  expect(search.failed).toBe(true);
  expect(search.searching).toBe(false);
  expect(search.exhausted).toBe(true);
  expect(search.hits).toEqual([]);
});

test('a failed next page keeps results and retries the same offset', async () => {
  const first = Array.from({ length: 30 }, (_, index) => hit(`$first${index}`));
  const messages = vi
    .fn()
    .mockResolvedValueOnce(page(first))
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce(page([hit('$next')]));
  const { core } = coreReturning(messages);
  const search = new MessageSearch(core, () => directory);
  search.query = 'deploy';
  search.schedule();
  await vi.advanceTimersByTimeAsync(500);
  await search.loadMore();
  expect(search.pageFailed).toBe(true);
  expect(search.failed).toBe(false);
  expect(search.hits).toEqual(first);
  await search.loadMore();
  expect(messages).toHaveBeenCalledTimes(2);
  await search.retryPage();
  expect(messages).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 30 }));
  expect(search.hits).toHaveLength(31);
  expect(search.pageFailed).toBe(false);
});

test('a failed older page retries its cursor without dropping recent results', async () => {
  const messages = vi
    .fn()
    .mockResolvedValueOnce(page([hit('$recent')], 'cold-cursor'))
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce(page([hit('$old')]));
  const { core } = coreReturning(messages);
  const search = new MessageSearch(core, () => directory);
  search.query = 'deploy';
  search.schedule();
  await vi.advanceTimersByTimeAsync(500);
  await search.loadMore();
  expect(search.hits.map((hit) => hit.event_id)).toEqual(['$recent']);
  expect(search.failed).toBe(false);
  await search.retryPage();
  expect(messages).toHaveBeenLastCalledWith(expect.objectContaining({ older: 'cold-cursor' }));
  expect(search.hits.map((hit) => hit.event_id)).toEqual(['$recent', '$old']);
});

test('indexing progress refreshes an unchanged query and coalesces updates', async () => {
  const messages = vi
    .fn()
    .mockResolvedValueOnce(page([]))
    .mockResolvedValue(page([hit('$indexed')]));
  const { core } = coreReturning(messages);
  const search = new MessageSearch(core, () => directory);
  search.updateCoverage(coverage(0));
  search.query = 'deploy';
  search.schedule();
  await vi.advanceTimersByTimeAsync(500);
  for (let documents = 1; documents <= 10; documents++) search.updateCoverage(coverage(documents));
  await vi.advanceTimersByTimeAsync(1_000);
  expect(messages).toHaveBeenCalledTimes(2);
  expect(messages).toHaveBeenLastCalledWith(
    expect.objectContaining({ query: 'deploy', offset: 0 })
  );
  expect(search.hits.map((hit) => hit.event_id)).toEqual(['$indexed']);
  search.updateCoverage(coverage(10));
  await vi.advanceTimersByTimeAsync(2_000);
  expect(messages).toHaveBeenCalledTimes(2);
});

test('indexing completion refreshes even when the document count is unchanged', async () => {
  const messages = vi.fn().mockResolvedValue(page([]));
  const { core } = coreReturning(messages);
  const search = new MessageSearch(core, () => directory);
  search.updateCoverage(coverage(10));
  search.query = 'deploy';
  search.schedule();
  await vi.advanceTimersByTimeAsync(500);
  search.updateCoverage(coverage(10, 'complete'));
  await vi.advanceTimersByTimeAsync(1_000);
  expect(messages).toHaveBeenCalledTimes(2);
});

test('indexing refresh waits for the current request', async () => {
  const messages = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            resolve(page([hit('$first')]));
          }, 2500);
        })
    )
    .mockResolvedValue(page([hit('$fresh')]));
  const { core } = coreReturning(messages);
  const search = new MessageSearch(core, () => directory);
  search.query = 'deploy';
  search.schedule();
  await vi.advanceTimersByTimeAsync(500);
  search.updateCoverage(coverage(100));
  await vi.advanceTimersByTimeAsync(1000);
  search.updateCoverage(coverage(101));
  await vi.advanceTimersByTimeAsync(1000);
  expect(messages).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1000);
  expect(search.hits.map((hit) => hit.event_id)).toEqual(['$fresh']);
  expect(messages).toHaveBeenCalledTimes(2);
  search.dispose();
});

test('indexing progress preserves loaded pages until an explicit refresh', async () => {
  const first = Array.from({ length: 30 }, (_, index) => hit(`$first${index}`));
  const messages = vi
    .fn()
    .mockResolvedValueOnce(page(first))
    .mockResolvedValueOnce(page([hit('$next')]))
    .mockResolvedValueOnce(page([hit('$fresh')]));
  const { core } = coreReturning(messages);
  const search = new MessageSearch(core, () => directory);
  search.query = 'deploy';
  search.schedule();
  await vi.advanceTimersByTimeAsync(500);
  await search.loadMore();
  search.updateCoverage(coverage(100));
  await vi.advanceTimersByTimeAsync(2_000);
  expect(search.hits).toHaveLength(31);
  expect(search.refreshAvailable).toBe(true);
  expect(messages).toHaveBeenCalledTimes(2);
  search.refresh();
  await vi.advanceTimersByTimeAsync(0);
  expect(search.hits.map((hit) => hit.event_id)).toEqual(['$fresh']);
  expect(search.refreshAvailable).toBe(false);
});

test('a refresh failure keeps the current results', async () => {
  const messages = vi
    .fn()
    .mockResolvedValueOnce(page([hit('$kept')]))
    .mockRejectedValueOnce(new Error('offline'));
  const { core } = coreReturning(messages);
  const search = new MessageSearch(core, () => directory);
  search.query = 'deploy';
  search.schedule();
  await vi.advanceTimersByTimeAsync(500);
  search.refresh();
  await vi.advanceTimersByTimeAsync(0);
  expect(search.hits.map((hit) => hit.event_id)).toEqual(['$kept']);
  expect(search.failed).toBe(true);
});

test('disposing cancels a queued indexing refresh', async () => {
  const messages = vi.fn().mockResolvedValue(page([]));
  const { core } = coreReturning(messages);
  const search = new MessageSearch(core, () => directory);
  search.query = 'deploy';
  search.schedule();
  await vi.advanceTimersByTimeAsync(500);
  search.updateCoverage(coverage(100));
  search.dispose();
  await vi.advanceTimersByTimeAsync(2_000);
  expect(messages).toHaveBeenCalledTimes(1);
});

test('disposing drops a pending search', async () => {
  const searchMessages = vi.fn().mockResolvedValue(page([hit('$a')]));
  const { core } = coreReturning(searchMessages);
  const search = new MessageSearch(core, () => directory);

  search.query = 'deploy';
  search.schedule();
  search.dispose();
  await vi.advanceTimersByTimeAsync(500);

  expect(searchMessages).not.toHaveBeenCalled();
  flushSync();
});

test('interleaved rooms produce distinct group keys', async () => {
  const searchMessages = vi.fn().mockResolvedValue(
    page([
      { ...hit('$a'), room_id: '!one:example.org' },
      { ...hit('$b'), room_id: '!two:example.org' },
      { ...hit('$c'), room_id: '!one:example.org' },
    ])
  );
  const { core } = coreReturning(searchMessages);
  const search = new MessageSearch(core, () => directory);

  search.query = 'deploy';
  search.schedule();
  await vi.advanceTimersByTimeAsync(500);

  const keys = search.groups.map((group) => group.key);
  expect(keys).toHaveLength(3);
  expect(new Set(keys).size).toBe(3);
  expect(search.groups.map((group) => group.roomId)).toEqual([
    '!one:example.org',
    '!two:example.org',
    '!one:example.org',
  ]);
});

test('a hit repeated across pages is kept once and the cursor still advances by page', async () => {
  const firstPage = Array.from({ length: 30 }, (_, index) => hit(`$first${String(index)}`));
  const secondPage = [
    hit('$first29'),
    ...Array.from({ length: 29 }, (_, index) => hit(`$second${String(index)}`)),
  ];
  const searchMessages = vi
    .fn()
    .mockResolvedValueOnce(page(firstPage))
    .mockResolvedValueOnce(page(secondPage))
    .mockResolvedValueOnce(page([]));
  const { core } = coreReturning(searchMessages);
  const search = new MessageSearch(core, () => directory);

  search.query = 'deploy';
  search.schedule();
  await vi.advanceTimersByTimeAsync(500);
  await search.loadMore();

  const ids = search.hits.map((entry) => entry.event_id);
  expect(ids).toHaveLength(59);
  expect(new Set(ids).size).toBe(59);

  await search.loadMore();
  expect(searchMessages).toHaveBeenLastCalledWith(
    expect.objectContaining({ query: 'deploy', offset: 60 })
  );
});

test('a space with no joined rooms finds nothing instead of searching everywhere', async () => {
  const searchMessages = vi.fn().mockResolvedValue(page([hit('$a')]));
  const { core } = coreReturning(searchMessages);
  const emptySpace: SearchDirectory = {
    rooms: [
      {
        room_id: '!empty:example.org',
        name: 'empty',
        canonical_alias: null,
        joined: true,
        is_tombstoned: false,
        is_space: true,
        is_direct: false,
        direct_targets: [],
        space_children: [],
      },
    ],
    people: [],
  };
  const search = new MessageSearch(core, () => emptySpace);

  search.query = 'space:empty deploy';
  search.schedule();
  await vi.advanceTimersByTimeAsync(500);

  expect(searchMessages).not.toHaveBeenCalled();
  expect(search.hits).toEqual([]);
  expect(search.searching).toBe(false);
  expect(search.unresolved).toEqual([]);
});
