import { expect, test, vi } from 'vitest';

import type { InboxItemView } from '#src/generated/protocol';

import { InboxFeed, type InboxFeedCommands } from './inbox-feed.svelte';

function item(eventId: string): InboxItemView {
  return {
    room_id: '!room:example.org',
    event_id: eventId,
    ts: 1,
    sender: '@alice:example.org',
    sender_name: 'Alice',
    body: 'hello',
    highlight: false,
    is_direct: false,
    encrypted: false,
    read: false,
    thread_root: null,
    reply: false,
  };
}

test('a slower earlier query never overwrites a newer one', async () => {
  let resolveFirst: (value: { items: InboxItemView[]; has_more: boolean }) => void = () => {};
  const inboxNotifications = vi
    .fn<InboxFeedCommands['inbox']>()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        })
    )
    .mockResolvedValueOnce({ items: [item('$new')], has_more: false });
  const feed = new InboxFeed({ inbox: inboxNotifications, backfillInbox: vi.fn() });

  const first = feed.load('all', false, 30);
  await feed.load('mentions', false, 30);
  resolveFirst({ items: [item('$stale')], has_more: true });
  await first;

  expect(feed.items.map((entry) => entry.event_id)).toEqual(['$new']);
  expect(feed.hasMore).toBe(false);
  expect(feed.loaded).toBe(true);
});

test('a failed backfill is reported and releases the busy flag', async () => {
  const feed = new InboxFeed({
    inbox: vi.fn(),
    backfillInbox: vi.fn(() => Promise.reject(new Error('offline'))),
  });

  await feed.backfill(false);

  expect(feed.failed).toBe(true);
  expect(feed.backfilling).toBe(false);
});

test('a backfill asked for while one runs runs once more afterwards', async () => {
  let finish: () => void = () => {};
  const backfillInbox = vi.fn(
    () =>
      new Promise<{ recorded: number; has_more: boolean }>((resolve) => {
        finish = () => {
          resolve({ recorded: 0, has_more: false });
        };
      })
  );
  const feed = new InboxFeed({ inbox: vi.fn(), backfillInbox });

  const first = feed.backfill(false);
  void feed.backfill(false);
  void feed.backfill(false);
  finish();
  await vi.waitFor(() => {
    expect(backfillInbox).toHaveBeenCalledTimes(2);
  });
  finish();
  await first;

  expect(backfillInbox).toHaveBeenCalledTimes(2);
  expect(feed.backfilling).toBe(false);
});

test('loading the empty cache preserves a failed catch-up until recovery succeeds', async () => {
  const backfillInbox = vi
    .fn<InboxFeedCommands['backfillInbox']>()
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue({ recorded: 0, has_more: false });
  const feed = new InboxFeed({
    inbox: vi.fn().mockResolvedValue({ items: [], has_more: false }),
    backfillInbox,
  });

  await feed.backfill(false);
  await feed.load('all', false, 30);
  expect(feed.failed).toBe(true);
  await feed.backfill(false);
  expect(feed.failed).toBe(false);
});

test('unread catch-up continues through empty batches', async () => {
  const backfillInbox = vi
    .fn<InboxFeedCommands['backfillInbox']>()
    .mockResolvedValueOnce({ recorded: 0, has_more: true })
    .mockResolvedValueOnce({ recorded: 1, has_more: false });
  const feed = new InboxFeed({ inbox: vi.fn(), backfillInbox });

  await feed.backfill(false);

  expect(backfillInbox).toHaveBeenCalledTimes(2);
  expect(feed.checked).toBe(true);
  expect(feed.backfilling).toBe(false);
});

test('history backfill fetches one batch per request', async () => {
  const backfillInbox = vi
    .fn<InboxFeedCommands['backfillInbox']>()
    .mockResolvedValue({ recorded: 1, has_more: true });
  const feed = new InboxFeed({ inbox: vi.fn(), backfillInbox });

  await feed.backfill(true);

  expect(backfillInbox).toHaveBeenCalledTimes(1);
});

test('leaving the inbox stops automatic pagination after the current batch', async () => {
  let finish: (value: { recorded: number; has_more: boolean }) => void = () => {};
  const backfillInbox = vi.fn<InboxFeedCommands['backfillInbox']>(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      })
  );
  const feed = new InboxFeed({ inbox: vi.fn(), backfillInbox });
  const pending = feed.backfill(false);
  feed.dispose();
  finish({ recorded: 0, has_more: true });
  await pending;
  expect(backfillInbox).toHaveBeenCalledTimes(1);
});

test('a queued history request cannot hide an unread catch-up failure', async () => {
  let fail: (error: Error) => void = () => {};
  const backfillInbox = vi
    .fn<InboxFeedCommands['backfillInbox']>()
    .mockImplementationOnce(
      () =>
        new Promise((_, reject) => {
          fail = reject;
        })
    )
    .mockResolvedValue({ recorded: 0, has_more: false });
  const feed = new InboxFeed({ inbox: vi.fn(), backfillInbox });
  const pending = feed.backfill(false);
  void feed.backfill(true);
  fail(new Error('offline'));
  await pending;
  expect(backfillInbox.mock.calls.map(([params]) => params.include_read)).toEqual([false, true]);
  expect(feed.failed).toBe(true);
  await feed.backfill(false);
  expect(feed.failed).toBe(false);
});

test('a feed for one room asks the core for that room once', async () => {
  const inboxNotifications = vi
    .fn<InboxFeedCommands['inbox']>()
    .mockResolvedValue({ items: [item('$a')], has_more: true });
  const backfillInbox = vi
    .fn<InboxFeedCommands['backfillInbox']>()
    .mockResolvedValue({ recorded: 0, has_more: false });
  const feed = new InboxFeed({ inbox: inboxNotifications, backfillInbox }, '!room');

  await feed.load('all', true, 30, 'alice');
  await feed.backfill(true);

  expect(inboxNotifications).toHaveBeenCalledOnce();
  expect(inboxNotifications).toHaveBeenCalledWith({
    filter: 'all',
    include_read: true,
    limit: 30,
    before_ts: null,
    room_id: '!room',
    query: 'alice',
  });
  expect(feed.hasMore).toBe(true);
  expect(backfillInbox).toHaveBeenCalledWith({ include_read: true, room_id: '!room' });
});
