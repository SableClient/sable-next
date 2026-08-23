import { flushSync } from 'svelte';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import type { SearchHitView } from '#src/generated/SearchHitView';

import type { CoreClient } from '#lib/core/client.svelte.js';

import { MessageSearch } from './message-search.svelte.js';

const resolvers = {
  roomId: (value: string) => value,
  userId: (value: string) => value,
};

function hit(eventId: string): SearchHitView {
  return {
    room_id: '!room:example.org',
    event_id: eventId,
    body: 'the deploy pipeline is broken',
    sender: '@erwan:example.org',
    origin_server_ts: 1_700_000_000_000,
    score: 1,
  };
}

function coreReturning(searchMessages: CoreClient['searchMessages']): {
  core: CoreClient;
  searchMessages: CoreClient['searchMessages'];
} {
  return { core: { searchMessages } as unknown as CoreClient, searchMessages };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

test('an empty query clears results without asking the core', async () => {
  const searchMessages = vi.fn().mockResolvedValue([hit('$a')]);
  const { core } = coreReturning(searchMessages);
  const search = new MessageSearch(core, () => resolvers);

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
  const searchMessages = vi.fn().mockResolvedValue([hit('$a')]);
  const { core } = coreReturning(searchMessages);
  const search = new MessageSearch(core, () => resolvers);

  search.query = 'dep';
  search.schedule();
  search.query = 'depl';
  search.schedule();
  search.query = 'deploy';
  search.schedule();
  await vi.advanceTimersByTimeAsync(500);

  expect(searchMessages).toHaveBeenCalledTimes(1);
  expect(searchMessages).toHaveBeenCalledWith(
    'deploy',
    expect.objectContaining({ order: 'rank', limit: 30, offset: 0 })
  );
});

test('a slow response for an abandoned query never lands', async () => {
  const searchMessages = vi
    .fn()
    .mockImplementationOnce(
      async () =>
        new Promise<SearchHitView[]>((resolve) => {
          setTimeout(() => {
            resolve([hit('$stale')]);
          }, 1_000);
        })
    )
    .mockResolvedValueOnce([hit('$fresh')]);
  const { core } = coreReturning(searchMessages);
  const search = new MessageSearch(core, () => resolvers);

  search.query = 'stale';
  search.schedule();
  await vi.advanceTimersByTimeAsync(250);

  search.query = 'fresh';
  search.schedule();
  await vi.advanceTimersByTimeAsync(2_000);

  expect(search.hits.map((entry) => entry.event_id)).toEqual(['$fresh']);
});

test('a short page marks the results exhausted', async () => {
  const searchMessages = vi.fn().mockResolvedValue([hit('$a'), hit('$b')]);
  const { core } = coreReturning(searchMessages);
  const search = new MessageSearch(core, () => resolvers);

  search.query = 'deploy';
  search.schedule();
  await vi.advanceTimersByTimeAsync(500);

  expect(search.exhausted).toBe(true);

  await search.loadMore();
  expect(searchMessages).toHaveBeenCalledTimes(1);
});

test('a full page loads more and appends', async () => {
  const firstPage = Array.from({ length: 30 }, (_, index) => hit(`$first${String(index)}`));
  const searchMessages = vi
    .fn()
    .mockResolvedValueOnce(firstPage)
    .mockResolvedValueOnce([hit('$second')]);
  const { core } = coreReturning(searchMessages);
  const search = new MessageSearch(core, () => resolvers);

  search.query = 'deploy';
  search.schedule();
  await vi.advanceTimersByTimeAsync(500);
  expect(search.exhausted).toBe(false);

  await search.loadMore();

  expect(search.hits).toHaveLength(31);
  expect(searchMessages).toHaveBeenLastCalledWith(
    'deploy',
    expect.objectContaining({ limit: 30, offset: 30 })
  );
  expect(search.exhausted).toBe(true);
});

test('a failure reports itself and stops paging', async () => {
  const searchMessages = vi.fn().mockRejectedValue(new Error('core is gone'));
  const { core } = coreReturning(searchMessages);
  const search = new MessageSearch(core, () => resolvers);

  search.query = 'deploy';
  search.schedule();
  await vi.advanceTimersByTimeAsync(500);

  expect(search.failed).toBe(true);
  expect(search.searching).toBe(false);
  expect(search.exhausted).toBe(true);
  expect(search.hits).toEqual([]);
});

test('disposing drops a pending search', async () => {
  const searchMessages = vi.fn().mockResolvedValue([hit('$a')]);
  const { core } = coreReturning(searchMessages);
  const search = new MessageSearch(core, () => resolvers);

  search.query = 'deploy';
  search.schedule();
  search.dispose();
  await vi.advanceTimersByTimeAsync(500);

  expect(searchMessages).not.toHaveBeenCalled();
  flushSync();
});

test('interleaved rooms produce distinct group keys', async () => {
  const searchMessages = vi.fn().mockResolvedValue([
    { ...hit('$a'), room_id: '!one:example.org' },
    { ...hit('$b'), room_id: '!two:example.org' },
    { ...hit('$c'), room_id: '!one:example.org' },
  ]);
  const { core } = coreReturning(searchMessages);
  const search = new MessageSearch(core, () => resolvers);

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
