import { expect, test, vi } from 'vitest';

import type { BookmarkView } from '#src/generated/BookmarkView';

import { Bookmarks, type BookmarkCommands } from './bookmarks.svelte.js';

function bookmark(roomId: string, eventId: string): BookmarkView {
  return {
    bookmark_id: `bmk_${eventId}`,
    room_id: roomId,
    event_id: eventId,
    room_name: null,
    sender: null,
    body_preview: null,
    event_ts: 0,
    bookmarked_ts: 0,
  };
}

function fakeCore(
  bookmarks = vi.fn(() => Promise.resolve<BookmarkView[]>([])),
  setBookmark = vi.fn(() => Promise.resolve(false))
) {
  return { bookmarks, setBookmark } as unknown as BookmarkCommands;
}

test('one load answers for every room and every event', async () => {
  const bookmarks = vi.fn(() =>
    Promise.resolve([bookmark('!a:example.org', '$one'), bookmark('!b:example.org', '$two')])
  );
  const store = new Bookmarks(fakeCore(bookmarks));

  await store.load();

  expect(bookmarks).toHaveBeenCalledTimes(1);
  expect(store.has('!a:example.org', '$one')).toBe(true);
  expect(store.has('!b:example.org', '$two')).toBe(true);
  expect(store.has('!a:example.org', '$two')).toBe(false);
  expect(store.has('!a:example.org', null)).toBe(false);
});

test('a second load does not fetch again', async () => {
  const bookmarks = vi.fn(() => Promise.resolve([bookmark('!a:example.org', '$one')]));
  const store = new Bookmarks(fakeCore(bookmarks));

  await store.load();
  await store.load();

  expect(bookmarks).toHaveBeenCalledTimes(1);
});

test('concurrent loads share one fetch', async () => {
  const bookmarks = vi.fn(() => Promise.resolve([bookmark('!a:example.org', '$one')]));
  const store = new Bookmarks(fakeCore(bookmarks));

  await Promise.all([store.load(), store.load()]);

  expect(bookmarks).toHaveBeenCalledTimes(1);
});

test('toggling a loaded bookmark off passes the current state through', async () => {
  const setBookmark = vi.fn(() => Promise.resolve(false));
  const store = new Bookmarks(
    fakeCore(
      vi.fn(() => Promise.resolve([bookmark('!a:example.org', '$one')])),
      setBookmark
    )
  );

  await store.load();
  await store.toggle('!a:example.org', '$one');

  expect(setBookmark).toHaveBeenCalledWith('!a:example.org', '$one', false);
  expect(store.has('!a:example.org', '$one')).toBe(false);
});

test('toggling on without a load still tracks the new bookmark', async () => {
  const setBookmark = vi.fn(() => Promise.resolve(true));
  const store = new Bookmarks(fakeCore(undefined, setBookmark));

  await store.toggle('!a:example.org', '$one');

  expect(setBookmark).toHaveBeenCalledWith('!a:example.org', '$one', true);
  expect(store.has('!a:example.org', '$one')).toBe(true);
});

test('the server has the last word on whether the toggle took', async () => {
  const setBookmark = vi.fn(() => Promise.resolve(false));
  const store = new Bookmarks(fakeCore(undefined, setBookmark));

  await store.toggle('!a:example.org', '$one');

  expect(store.has('!a:example.org', '$one')).toBe(false);
});

test('a slow load cannot undo a toggle that raced it', async () => {
  let release: (bookmarks: BookmarkView[]) => void = () => {};
  const bookmarks = vi
    .fn()
    .mockImplementationOnce(() => new Promise<BookmarkView[]>((resolve) => (release = resolve)))
    .mockImplementationOnce(() => Promise.resolve([bookmark('!a:example.org', '$one')]));
  const store = new Bookmarks(
    fakeCore(
      bookmarks,
      vi.fn(() => Promise.resolve(true))
    )
  );

  const stale = store.load();
  await store.toggle('!a:example.org', '$one');
  release([]);
  await stale;

  expect(store.has('!a:example.org', '$one')).toBe(true);

  // The discarded snapshot left the store unloaded, so it tries once more.
  await store.load();
  expect(bookmarks).toHaveBeenCalledTimes(2);
});

test('a failed load is retried on the next call', async () => {
  const bookmarks = vi
    .fn()
    .mockImplementationOnce(() => Promise.reject(new Error('offline')))
    .mockImplementationOnce(() => Promise.resolve([bookmark('!a:example.org', '$one')]));
  const store = new Bookmarks(fakeCore(bookmarks));

  await store.load();
  expect(store.has('!a:example.org', '$one')).toBe(false);

  await store.load();
  expect(store.has('!a:example.org', '$one')).toBe(true);
});
