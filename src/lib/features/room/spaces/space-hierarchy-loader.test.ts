import { afterEach, expect, test, vi } from 'vitest';

import type { SpaceHierarchyRoomView } from '#src/generated/protocol';
import type { CoreClient } from '#lib/core/client.svelte.js';

import { SpaceHierarchyLoader } from './space-hierarchy-loader.svelte';

type Page = { rooms: SpaceHierarchyRoomView[]; next_batch: string | null };

function view(roomId: string): SpaceHierarchyRoomView {
  return { room_id: roomId } as SpaceHierarchyRoomView;
}

function fakeCore(
  spaceHierarchy: (params: { space_id: string; from: string | null }) => Promise<Page>
) {
  const spaces = { hierarchy: vi.fn(spaceHierarchy) };
  return {
    core: { session: { account_id: 'account' }, rpc: { spaces } } as unknown as CoreClient,
    spaceHierarchy: spaces.hierarchy,
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
    Promise.resolve({ rooms: [view('!child:x')], next_batch: null })
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

  answer({ rooms: [view('!child:x')], next_batch: null });

  await vi.waitFor(() => {
    expect(second.fetched.map((room) => room.room_id)).toEqual(['!child:x']);
  });
  expect(first.fetched.map((room) => room.room_id)).toEqual(['!child:x']);
  expect(spaceHierarchy).toHaveBeenCalledTimes(1);
});

test('a stale level paints at once and is replaced by the refetch', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  let rooms = [view('!old:x')];
  const { core, spaceHierarchy } = fakeCore(() => Promise.resolve({ rooms, next_batch: null }));
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
      : Promise.resolve({ rooms: [view('!kept:x')], next_batch: null })
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

test('a removed child stays gone from the cached level on revisit', async () => {
  const space = {
    room_id: '!removal:x',
    children: [{ room_id: '!gone:x' }, { room_id: '!kept:x' }],
  } as SpaceHierarchyRoomView;
  const { core } = fakeCore(() => Promise.resolve({ rooms: [space], next_batch: null }));
  const first = load(core, '!removal:x');
  await vi.waitFor(() => {
    expect(first.loadedLevels.has('!removal:x')).toBe(true);
  });

  first.forgetChild('!removal:x', '!gone:x');
  const second = load(core, '!removal:x');

  for (const loader of [first, second]) {
    expect(loader.fetched[0].children.map((edge) => edge.room_id)).toEqual(['!kept:x']);
  }
});
