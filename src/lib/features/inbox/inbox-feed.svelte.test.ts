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
  };
}

test('a slower earlier query never overwrites a newer one', async () => {
  let resolveFirst: (value: { items: InboxItemView[]; hasMore: boolean }) => void = () => {};
  const inboxNotifications = vi
    .fn<InboxFeedCommands['inboxNotifications']>()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        })
    )
    .mockResolvedValueOnce({ items: [item('$new')], hasMore: false });
  const feed = new InboxFeed({ inboxNotifications, backfillInbox: vi.fn() });

  const first = feed.load('all', false, 30);
  await feed.load('mentions', false, 30);
  resolveFirst({ items: [item('$stale')], hasMore: true });
  await first;

  expect(feed.items.map((entry) => entry.event_id)).toEqual(['$new']);
  expect(feed.hasMore).toBe(false);
  expect(feed.loaded).toBe(true);
});

test('a failed backfill is reported and releases the busy flag', async () => {
  const feed = new InboxFeed({
    inboxNotifications: vi.fn(),
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
      new Promise<number>((resolve) => {
        finish = () => {
          resolve(0);
        };
      })
  );
  const feed = new InboxFeed({ inboxNotifications: vi.fn(), backfillInbox });

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
