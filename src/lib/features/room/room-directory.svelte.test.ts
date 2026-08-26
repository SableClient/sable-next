import { expect, test, vi } from 'vitest';

import type { PublicRoomView } from '#src/generated/PublicRoomView';

import { RoomDirectory, type RoomDirectoryApi } from './room-directory.svelte.js';

type Page = { rooms: PublicRoomView[]; next_batch: string | null; total: number | null };

function room(roomId: string): PublicRoomView {
  return {
    room_id: roomId,
    canonical_alias: null,
    name: null,
    topic: null,
    avatar_url: null,
    is_space: false,
    is_voice: false,
    num_joined_members: 1,
    join_rule: 'public',
    guest_can_join: false,
    world_readable: true,
  };
}

function page(ids: string[], next: string | null = null, total: number | null = null): Page {
  return { rooms: ids.map(room), next_batch: next, total };
}

function fakeCore(publicRooms: RoomDirectoryApi['publicRooms']): RoomDirectoryApi {
  return { publicRooms };
}

test('a search asks the directory with the query it was given', async () => {
  const publicRooms = vi.fn(() => Promise.resolve(page(['!a'], null, 7)));
  const directory = new RoomDirectory(fakeCore(publicRooms));

  await directory.search({ server: 'other.org', search: 'rust' });

  expect(publicRooms).toHaveBeenCalledWith({ server: 'other.org', search: 'rust', since: null });
  expect(directory.rooms.map((entry) => entry.room_id)).toEqual(['!a']);
  expect(directory.total).toBe(7);
  expect(directory.hasMore).toBe(false);
  expect(directory.loading).toBe(false);
});

test('a next batch is paged in and appended', async () => {
  const publicRooms = vi
    .fn()
    .mockResolvedValueOnce(page(['!a'], 'page-2'))
    .mockResolvedValueOnce(page(['!b']));
  const directory = new RoomDirectory(fakeCore(publicRooms));

  await directory.search({ server: null, search: '' });
  expect(directory.hasMore).toBe(true);

  await directory.loadMore();

  expect(publicRooms).toHaveBeenLastCalledWith({ server: null, search: '', since: 'page-2' });
  expect(directory.rooms.map((entry) => entry.room_id)).toEqual(['!a', '!b']);
  expect(directory.hasMore).toBe(false);
});

test('a room repeated across pages is listed once', async () => {
  const publicRooms = vi
    .fn()
    .mockResolvedValueOnce(page(['!a', '!b'], 'page-2'))
    .mockResolvedValueOnce(page(['!b', '!c']));
  const directory = new RoomDirectory(fakeCore(publicRooms));

  await directory.search({ server: null, search: '' });
  await directory.loadMore();

  expect(directory.rooms.map((entry) => entry.room_id)).toEqual(['!a', '!b', '!c']);
});

test('loading more without a next batch asks nothing', async () => {
  const publicRooms = vi.fn(() => Promise.resolve(page(['!a'])));
  const directory = new RoomDirectory(fakeCore(publicRooms));

  await directory.search({ server: null, search: '' });
  await directory.loadMore();

  expect(publicRooms).toHaveBeenCalledTimes(1);
});

test('a slow first search cannot overwrite the one that replaced it', async () => {
  let release: (value: Page) => void = () => {};
  const publicRooms = vi
    .fn()
    .mockImplementationOnce(() => new Promise<Page>((resolve) => (release = resolve)))
    .mockImplementationOnce(() => Promise.resolve(page(['!new'])));
  const directory = new RoomDirectory(fakeCore(publicRooms));

  const stale = directory.search({ server: null, search: 'old' });
  await directory.search({ server: null, search: 'new' });
  release(page(['!old'], 'stale-page'));
  await stale;

  expect(directory.rooms.map((entry) => entry.room_id)).toEqual(['!new']);
  expect(directory.hasMore).toBe(false);
  expect(directory.loading).toBe(false);
});

test('a slow page cannot append to a search that replaced it', async () => {
  let release: (value: Page) => void = () => {};
  const publicRooms = vi
    .fn()
    .mockResolvedValueOnce(page(['!a'], 'page-2'))
    .mockImplementationOnce(() => new Promise<Page>((resolve) => (release = resolve)))
    .mockImplementationOnce(() => Promise.resolve(page(['!new'])));
  const directory = new RoomDirectory(fakeCore(publicRooms));

  await directory.search({ server: null, search: 'old' });
  const stale = directory.loadMore();
  await directory.search({ server: null, search: 'new' });
  release(page(['!b']));
  await stale;

  expect(directory.rooms.map((entry) => entry.room_id)).toEqual(['!new']);
});

test('a failure is reported and stops paging', async () => {
  const publicRooms = vi
    .fn()
    .mockResolvedValueOnce(page(['!a'], 'page-2'))
    .mockRejectedValueOnce(new Error('offline'));
  const directory = new RoomDirectory(fakeCore(publicRooms));

  await directory.search({ server: null, search: '' });
  await directory.loadMore();

  expect(directory.error).toBe('room.directoryFailed');
  expect(directory.hasMore).toBe(false);
  expect(directory.rooms.map((entry) => entry.room_id)).toEqual(['!a']);
  expect(directory.loading).toBe(false);
});

test('a new search clears an earlier failure', async () => {
  const publicRooms = vi
    .fn()
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce(page(['!a']));
  const directory = new RoomDirectory(fakeCore(publicRooms));

  await directory.search({ server: null, search: '' });
  expect(directory.error).toBe('room.directoryFailed');

  await directory.search({ server: null, search: 'again' });
  expect(directory.error).toBeNull();
});
