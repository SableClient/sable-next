import { afterEach, expect, test, vi } from 'vitest';

import type { SpaceHierarchyRoomView } from '#src/generated/protocol';
import type { CoreClient } from '#lib/core/client.svelte.js';

import { SpaceHierarchyLoader } from './space-hierarchy-loader.svelte';

type Page = { rooms: SpaceHierarchyRoomView[]; nextBatch: string | null };

function view(roomId: string): SpaceHierarchyRoomView {
  return { room_id: roomId } as SpaceHierarchyRoomView;
}

function fakeCore(spaceHierarchy: (spaceId: string, from: string | null) => Promise<Page>) {
  const commands = { spaceHierarchy: vi.fn(spaceHierarchy) };
  return {
    core: { session: { account_id: 'account' }, commands } as unknown as CoreClient,
    spaceHierarchy: commands.spaceHierarchy,
  };
}

function load(core: CoreClient, spaceId: string): SpaceHierarchyLoader {
  const loader = new SpaceHierarchyLoader(core);
  loader.reset(spaceId);
  loader.enqueue([spaceId]);
  return loader;
}

afterEach(() => {
  vi.useRealTimers();
});

test('a revisit paints the cached level without asking again', async () => {
  const { core, spaceHierarchy } = fakeCore(() =>
    Promise.resolve({ rooms: [view('!child:x')], nextBatch: null })
  );
  const first = load(core, '!cached:x');
  await vi.waitFor(() => {
    expect(first.loadedLevels.has('!cached:x')).toBe(true);
  });

  const second = load(core, '!cached:x');

  expect(second.loadedLevels.has('!cached:x')).toBe(true);
  expect(second.fetched.map((room) => room.room_id)).toEqual(['!child:x']);
  expect(spaceHierarchy).toHaveBeenCalledTimes(1);
});

test('a revisit joins a request that is still running', async () => {
  let answer: (page: Page) => void = () => undefined;
  const { core, spaceHierarchy } = fakeCore(
    () =>
      new Promise((resolve) => {
        answer = resolve;
      })
  );
  const first = load(core, '!running:x');
  const second = load(core, '!running:x');

  answer({ rooms: [view('!child:x')], nextBatch: null });

  await vi.waitFor(() => {
    expect(second.fetched.map((room) => room.room_id)).toEqual(['!child:x']);
  });
  expect(first.fetched.map((room) => room.room_id)).toEqual(['!child:x']);
  expect(spaceHierarchy).toHaveBeenCalledTimes(1);
});

test('a stale level paints at once and is replaced by the refetch', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  let rooms = [view('!old:x')];
  const { core, spaceHierarchy } = fakeCore(() => Promise.resolve({ rooms, nextBatch: null }));
  const first = load(core, '!stale:x');
  await vi.waitFor(() => {
    expect(first.loadedLevels.has('!stale:x')).toBe(true);
  });
  vi.setSystemTime(Date.now() + 5 * 60_000);
  rooms = [view('!new:x')];

  const second = load(core, '!stale:x');

  expect(second.fetched.map((room) => room.room_id)).toEqual(['!old:x']);
  expect(second.pendingLevels.size).toBe(0);
  await vi.waitFor(() => {
    expect(second.fetched.map((room) => room.room_id)).toEqual(['!new:x']);
  });
  expect(spaceHierarchy).toHaveBeenCalledTimes(2);
});

test('a failed refetch keeps the stale level without failing the lobby', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  let fail = false;
  const { core } = fakeCore(() =>
    fail
      ? Promise.reject(new Error('offline'))
      : Promise.resolve({ rooms: [view('!kept:x')], nextBatch: null })
  );
  const first = load(core, '!flaky:x');
  await vi.waitFor(() => {
    expect(first.loadedLevels.has('!flaky:x')).toBe(true);
  });
  vi.setSystemTime(Date.now() + 5 * 60_000);
  fail = true;
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

  const second = load(core, '!flaky:x');

  await vi.waitFor(() => {
    expect(warn).toHaveBeenCalled();
  });
  expect(second.failed).toBe(false);
  expect(second.fetched.map((room) => room.room_id)).toEqual(['!kept:x']);
  warn.mockRestore();
});
