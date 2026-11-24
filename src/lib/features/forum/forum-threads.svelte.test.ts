import { afterEach, expect, onTestFinished, test, vi } from 'vitest';

import type { CoreClient } from '#lib/core/client.svelte.js';
import { createCoreStub } from '#lib/core/__mocks__/context.js';
import type { CoreEvent, TimelineItemView } from '#src/generated/protocol';
import { timelineItem } from '#lib/features/room/timeline/test-items.js';

import { ForumThreads } from './forum-threads.svelte';

afterEach(() => vi.useRealTimers());

function fixture(items: TimelineItemView[], listed: TimelineItemView[]) {
  const listeners = new Set<(event: CoreEvent) => void>();
  const core = {
    ...createCoreStub(),
    subscribeEvents: vi.fn((listener: (event: CoreEvent) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }),
  };
  core.rpc.timeline.subscribe.mockResolvedValue({ subscription: 1, items, aggregations: [] });
  core.rpc.timeline.unsubscribe.mockResolvedValue(null);
  core.rpc.timeline.readMarker.mockResolvedValue(null);
  core.rpc.timeline.eventItems.mockResolvedValue([]);
  core.rpc.timeline.unreadDiagnostics.mockResolvedValue({
    main: { unread: 0, notifying: 0, highlight: 0, receipt_event_id: null },
    server_notifications: 0,
    server_highlights: 0,
    unthreaded_receipt_timestamp: null,
    threads: [],
  });
  core.rpc.timeline.listThreads.mockResolvedValue({ roots: listed, next_batch: null });
  const forum = new ForumThreads(core as unknown as CoreClient);
  onTestFinished(() => forum.stop());
  return {
    core,
    forum,
    emit: (event: CoreEvent) => {
      for (const listener of listeners) listener(event);
    },
  };
}

test('a live redaction removes a root while discovery still has its old content', async () => {
  const root = timelineItem('root');
  const other = timelineItem('other');
  const { forum, emit } = fixture([root, other], [root]);
  await forum.start('!forum:example.org');
  expect(forum.threads).toHaveLength(2);

  emit({
    type: 'timeline_diff',
    subscription: 1,
    diffs: [
      {
        op: 'set',
        index: 0,
        value: {
          ...root,
          content: { kind: 'redacted', reason: null, redacted_by: null },
        },
      },
    ],
  });

  expect(forum.threads.map((thread) => thread.eventId)).toEqual(['$other']);
});

test('an older redacted thread stays hidden through discovery refresh and reopening', async () => {
  vi.useFakeTimers();
  const root = {
    ...timelineItem('root'),
    content: { kind: 'redacted' as const, reason: null, redacted_by: null },
    thread_summary: {
      num_replies: 2,
      latest_event_id: '$reply',
      latest_timestamp: null,
      latest_sender: null,
      current_user_participated: null,
      latest_body: 'Old reply',
      latest_fallback: null,
      latest_emotes: [],
    },
  };
  const other = timelineItem('other');
  const { forum, core, emit } = fixture([other], [root]);
  core.rpc.timeline.listThreads.mockResolvedValueOnce({ roots: [root], next_batch: 'older' });
  core.rpc.timeline.paginate.mockResolvedValue({ direction: 'backward', reached_end: true });
  await forum.start('!forum:example.org');
  expect(forum.threads.map((thread) => thread.eventId)).toEqual(['$other']);
  await forum.paginateBackward();
  expect(forum.threads.map((thread) => thread.eventId)).toEqual(['$other']);

  emit({ type: 'threads_changed', room_id: '!forum:example.org' });
  await vi.advanceTimersByTimeAsync(250);
  expect(core.rpc.timeline.listThreads).toHaveBeenCalledTimes(3);
  expect(forum.threads.map((thread) => thread.eventId)).toEqual(['$other']);
  await forum.stop();
  await forum.start('!forum:example.org');
  expect(forum.threads.map((thread) => thread.eventId)).toEqual(['$other']);
});

test('a failed page is retried so a search can still reach older threads', async () => {
  vi.useFakeTimers();
  const { forum, core } = fixture([timelineItem('newest')], []);
  core.rpc.timeline.paginate
    .mockRejectedValueOnce(new Error('connection reset'))
    .mockResolvedValue({ direction: 'backward', reached_end: false });
  await forum.start('!forum:example.org');

  const page = forum.paginateBackward();
  await vi.advanceTimersByTimeAsync(0);
  expect(forum.error).toBe(true);
  await vi.advanceTimersByTimeAsync(1000);

  await expect(page).resolves.toBe(false);
  expect(forum.error).toBe(false);
  expect(forum.canLoadMore).toBe(true);
  expect(core.rpc.timeline.paginate).toHaveBeenCalledTimes(2);
});

test('a page that keeps failing gives up and shows the failure', async () => {
  vi.useFakeTimers();
  const { forum, core } = fixture([timelineItem('newest')], []);
  core.rpc.timeline.paginate.mockRejectedValue(new Error('connection reset'));
  await forum.start('!forum:example.org');

  const page = forum.paginateBackward();
  const settled = expect(page).rejects.toThrow('Unable to load forum threads');
  await vi.advanceTimersByTimeAsync(7000);

  await settled;
  expect(forum.error).toBe(true);
  expect(core.rpc.timeline.paginate).toHaveBeenCalledTimes(4);
});

test('leaving the forum stops retrying a failed page', async () => {
  vi.useFakeTimers();
  const { forum, core } = fixture([timelineItem('newest')], []);
  core.rpc.timeline.paginate.mockRejectedValue(new Error('connection reset'));
  await forum.start('!forum:example.org');

  const page = forum.paginateBackward().catch(() => {});
  await vi.advanceTimersByTimeAsync(0);
  await forum.stop();
  await vi.advanceTimersByTimeAsync(7000);
  await page;

  expect(core.rpc.timeline.paginate).toHaveBeenCalledTimes(1);
});

test('a listed post outside the timeline shows its votes and updates after the user votes', async () => {
  const live = timelineItem('live');
  const older = { ...timelineItem('older'), thread_summary: null };
  const { core, forum } = fixture([live], [older]);
  core.rpc.messages.eventReactions.mockResolvedValue([
    { key: '👍', senders: ['@ana:example.org'] },
  ]);
  await forum.start('!forum:example.org');

  forum.loadListedReactions();
  forum.loadListedReactions();
  await vi.waitFor(() => {
    expect(forum.threads.find((thread) => thread.eventId === '$older')?.votes).toBe(1);
  });
  expect(core.rpc.messages.eventReactions).toHaveBeenCalledExactlyOnceWith({
    room_id: '!forum:example.org',
    event_id: '$older',
  });

  core.rpc.messages.eventReactions.mockResolvedValue([
    { key: '👍', senders: ['@ana:example.org', '@me:example.org'] },
  ]);
  await forum.refreshReactions('$older');
  expect(forum.threads.find((thread) => thread.eventId === '$older')?.votes).toBe(2);

  await forum.refreshReactions('$live');
  expect(core.rpc.messages.eventReactions).toHaveBeenCalledTimes(2);
});

test('votes of listed posts still load after switching forums mid-request', async () => {
  const listed = ['older', 'b', 'c', 'd'].map((id) => ({
    ...timelineItem(id),
    thread_summary: null,
  }));
  const { core, forum } = fixture([timelineItem('live')], listed);
  const pending = Promise.withResolvers<{ key: string; senders: string[] }[]>();
  core.rpc.messages.eventReactions.mockReturnValue(pending.promise);
  await forum.start('!first:example.org');
  forum.loadListedReactions();

  await forum.start('!second:example.org');
  pending.resolve([{ key: '👍', senders: ['@ana:example.org', '@bo:example.org'] }]);
  core.rpc.messages.eventReactions.mockResolvedValue([
    { key: '👍', senders: ['@ana:example.org'] },
  ]);
  forum.loadListedReactions();

  await vi.waitFor(() => {
    expect(forum.threads.find((thread) => thread.eventId === '$older')?.votes).toBe(1);
  });
  expect(core.rpc.messages.eventReactions).toHaveBeenCalledWith({
    room_id: '!second:example.org',
    event_id: '$older',
  });
});
