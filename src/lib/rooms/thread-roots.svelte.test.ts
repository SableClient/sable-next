import { afterEach, expect, test, vi } from 'vitest';
import type { CoreEvent } from '#src/generated/protocol';
import { createCoreStub } from '#lib/core/__mocks__/context.js';
import type { CoreClient } from '#lib/core/client.svelte.js';
import { timelineItem } from '../../../tests/e2e/fixtures/timeline-items';
import { clearThreadRepliesCache } from './thread-replies.js';
import { THREAD_ACTIVITY_WINDOW, ThreadRoots } from './thread-roots.svelte';

afterEach(() => {
  clearThreadRepliesCache();
  vi.useRealTimers();
});

type SummaryOverrides = Partial<NonNullable<ReturnType<typeof timelineItem>['thread_summary']>>;

function threadRoot(id: string, body: string, timestamp: number, summary?: SummaryOverrides) {
  return {
    ...timelineItem(id, body),
    timestamp,
    ...(summary && {
      thread_summary: {
        num_replies: 1,
        latest_event_id: null,
        latest_timestamp: null,
        latest_sender: null,
        current_user_participated: null,
        latest_body: null,
        latest_fallback: null,
        latest_emotes: [],
        ...summary,
      },
    }),
  };
}

function diagnostics(
  threads: {
    root_event_id: string;
    unread: number;
    notifying: number;
    highlight: number;
    receipt_event_id: string | null;
    receipt_timestamp?: number | null;
  }[] = [],
  unthreaded_receipt_timestamp: number | null = null
) {
  return {
    main: { unread: 0, notifying: 0, highlight: 0, receipt_event_id: null },
    server_notifications: 0,
    server_highlights: 0,
    unthreaded_receipt_timestamp,
    threads,
  };
}

function fixture() {
  let emit: (event: CoreEvent) => void = () => {};
  const unsubscribe = vi.fn();
  const core = {
    ...createCoreStub(),
    subscribeEvents(listener: (event: CoreEvent) => void) {
      emit = listener;
      return unsubscribe;
    },
  };
  core.rpc.timeline.eventItems.mockResolvedValue([]);
  core.rpc.timeline.unreadDiagnostics.mockResolvedValue(diagnostics());
  const roots = new ThreadRoots(core as unknown as CoreClient);
  return {
    core,
    roots,
    unsubscribe,
    emit: (event: CoreEvent) => {
      emit(event);
    },
  };
}

test('updates cached roots on room changes, preserving loaded pages and deduplicating roots', async () => {
  vi.useFakeTimers();
  const { core, roots, emit, unsubscribe } = fixture();
  const a = timelineItem('a', 'First topic');
  const b = timelineItem('b', 'Second topic');
  const list = core.rpc.timeline.listThreads;
  list.mockResolvedValueOnce({ roots: [a], next_batch: 'page2' });
  list.mockResolvedValueOnce({ roots: [a, b], next_batch: null });
  await roots.start('!forum:example.test');
  await roots.loadMore();
  expect(roots.items.map((root) => root.id)).toEqual(['a', 'b']);
  const changed = threadRoot('a', 'First topic', a.timestamp, {
    num_replies: 3,
    latest_body: 'New reply',
  });
  list.mockResolvedValueOnce({ roots: [changed], next_batch: 'page2' });
  list.mockResolvedValueOnce({ roots: [b], next_batch: null });
  emit({ type: 'threads_changed', room_id: '!other:example.test' });
  await vi.advanceTimersByTimeAsync(250);
  expect(list).toHaveBeenCalledTimes(2);
  emit({ type: 'threads_changed', room_id: '!forum:example.test' });
  emit({ type: 'threads_changed', room_id: '!forum:example.test' });
  await vi.advanceTimersByTimeAsync(250);
  expect(list).toHaveBeenCalledTimes(4);
  expect(roots.items[0]?.thread_summary?.num_replies).toBe(3);
  roots.stop();
  expect(unsubscribe).toHaveBeenCalledOnce();
});

test('a failed initial load is retryable and a stopped request cannot replace the next room', async () => {
  const { core, roots } = fixture();
  const list = core.rpc.timeline.listThreads;
  list.mockRejectedValueOnce(new Error('offline'));
  await roots.start('!first:example.test');
  expect(roots.error).toBe(true);
  list.mockResolvedValueOnce({ roots: [timelineItem('first', 'Recovered')], next_batch: null });
  await roots.retry();
  expect(roots.error).toBe(false);
  const pending = Promise.withResolvers<{
    roots: ReturnType<typeof timelineItem>[];
    next_batch: null;
  }>();
  list.mockReturnValueOnce(pending.promise);
  const old = roots.start('!old:example.test');
  list.mockResolvedValueOnce({ roots: [timelineItem('new', 'New room')], next_batch: null });
  await roots.start('!new:example.test');
  pending.resolve({ roots: [timelineItem('old', 'Old room')], next_batch: null });
  await old;
  expect(roots.items[0]?.id).toBe('new');
  roots.stop();
});

test('hydrates latest reply activity and explicit thread receipts without blocking the list', async () => {
  const { core, roots } = fixture();
  const topic = threadRoot('topic', 'Topic', 0, {
    num_replies: 2,
    latest_event_id: '$reply',
    latest_timestamp: null,
    latest_sender: null,
    current_user_participated: null,
    latest_body: 'Reply',
  });
  const reply = {
    ...timelineItem('reply', 'Reply'),
    event_id: '$reply',
    thread_root: topic.event_id,
  };
  core.rpc.timeline.listThreads.mockResolvedValue({ roots: [topic], next_batch: null });
  const latest = Promise.withResolvers<ReturnType<typeof timelineItem>[]>();
  core.rpc.timeline.eventItems.mockReturnValue(latest.promise);
  core.rpc.timeline.unreadDiagnostics.mockResolvedValue(
    diagnostics([
      {
        root_event_id: topic.event_id ?? '',
        unread: 0,
        notifying: 0,
        highlight: 0,
        receipt_event_id: '$reply',
      },
    ])
  );
  await roots.start('!forum:example.test');
  expect(roots.loading).toBe(false);
  expect(roots.items).toHaveLength(1);
  latest.resolve([reply]);
  await vi.waitFor(() => {
    expect(roots.latest).toEqual([reply]);
  });
  expect(roots.activity.has(topic.event_id ?? '')).toBe(false);
  expect(core.rpc.timeline.unreadDiagnostics).toHaveBeenCalledWith({
    room_id: '!forum:example.test',
    thread_roots: [topic.event_id],
  });
  roots.stop();
});

test('orders by reply activity and clears only the thread whose latest reply is read', async () => {
  const { core, roots } = fixture();
  const now = Date.now();
  const older = threadRoot('older', 'Older topic', now - 60_000, {
    num_replies: 3,
    latest_event_id: '$latest',
    latest_timestamp: now,
    latest_sender: '@other:example.org',
    latest_body: 'Latest reply',
  });
  const newer = threadRoot('newer', 'Newer topic', now - 30_000);
  core.rpc.timeline.listThreads.mockResolvedValue({ roots: [newer, older], next_batch: null });
  core.rpc.timeline.unreadDiagnostics.mockResolvedValue(
    diagnostics([
      {
        root_event_id: '$older:example.test',
        unread: 2,
        notifying: 0,
        highlight: 0,
        receipt_event_id: '$previous',
      },
    ])
  );
  await roots.start('!room:example.org');
  expect(roots.byActivity.map(({ id }) => id)).toEqual(['older', 'newer']);
  expect(roots.activity.get('$older:example.test')).toEqual({ fresh: false, replies: 2 });
  expect(roots.activity.get('$newer:example.test')).toEqual({ fresh: true, replies: 0 });

  roots.markRead('$older:example.test', {
    ...timelineItem('latest', 'Latest reply'),
    event_id: '$latest',
    timestamp: now,
  });

  expect([...roots.activity.keys()]).toEqual([newer.event_id]);
  expect(roots.byActivity.map(({ id }) => id)).toEqual(['older', 'newer']);
  roots.stop();
});

test('counts unread thread replies eagerly before a thread is opened', async () => {
  const { core, roots } = fixture();
  core.session = { user_id: '@me:example.org' };
  const now = Date.now();
  const thread = threadRoot('counted', 'Counted topic', now - 60_000, {
    num_replies: 5,
    latest_event_id: '$r5',
    latest_timestamp: now,
    latest_sender: '@other:example.org',
    latest_body: 'Reply 5',
  });
  core.rpc.timeline.listThreads.mockResolvedValue({ roots: [thread], next_batch: null });
  core.rpc.timeline.unreadDiagnostics.mockResolvedValue(
    diagnostics([
      {
        root_event_id: '$counted:example.test',
        unread: 0,
        notifying: 0,
        highlight: 0,
        receipt_event_id: '$r2',
      },
    ])
  );
  core.rpc.timeline.threadReplies.mockResolvedValue([
    { event_id: '$r5', sender: '@other:example.org', timestamp: now },
    { event_id: '$r4', sender: '@other:example.org', timestamp: now - 100 },
    { event_id: '$r3', sender: '@bob:example.org', timestamp: now - 200 },
    { event_id: '$r2', sender: '@other:example.org', timestamp: now - 300 },
  ]);

  await roots.start('!room:example.org');
  await vi.waitFor(() => {
    expect(roots.activity.get('$counted:example.test')).toEqual({ fresh: false, replies: 3 });
  });
  expect(core.rpc.timeline.threadReplies).toHaveBeenCalledWith({
    room_id: '!room:example.org',
    root_event_id: '$counted:example.test',
    limit: 50,
  });
  roots.stop();
});

test('ignores threads covered by unthreaded receipts, own replies, expiry, or markRootRead', async () => {
  const { core, roots } = fixture();
  core.session = { user_id: '@me:example.org' };
  const now = Date.now();
  const covered = threadRoot('covered', 'Covered topic', now - 5_000, {
    num_replies: 2,
    latest_event_id: '$c2',
    latest_timestamp: now - 4_000,
    latest_sender: '@other:example.org',
    latest_body: 'Earlier reply',
  });
  const ownReply = threadRoot('own', 'Own reply topic', now - 2_000, {
    num_replies: 2,
    latest_event_id: '$o2',
    latest_timestamp: now - 1_000,
    latest_sender: '@me:example.org',
    latest_body: 'My reply',
  });
  const expired = threadRoot('expired', 'Expired topic', now - THREAD_ACTIVITY_WINDOW - 60_000, {
    num_replies: 3,
    latest_event_id: '$e3',
    latest_timestamp: now - THREAD_ACTIVITY_WINDOW - 1_000,
    latest_sender: '@other:example.org',
    latest_body: 'Old reply',
  });
  const active = threadRoot('active', 'Active topic', now - 10_000, {
    num_replies: 2,
    latest_event_id: '$a2',
    latest_timestamp: now - 1_000,
    latest_sender: '@other:example.org',
    latest_body: 'New reply',
  });
  core.rpc.timeline.listThreads.mockResolvedValue({
    roots: [covered, ownReply, expired, active],
    next_batch: null,
  });
  core.rpc.timeline.unreadDiagnostics.mockResolvedValue(
    diagnostics(
      [
        {
          root_event_id: '$expired:example.test',
          unread: 2,
          notifying: 0,
          highlight: 0,
          receipt_event_id: '$expired:example.test',
          receipt_timestamp: now - THREAD_ACTIVITY_WINDOW - 60_000,
        },
        {
          root_event_id: '$active:example.test',
          unread: 1,
          notifying: 0,
          highlight: 0,
          receipt_event_id: '$a1',
        },
      ],
      now - 3_000
    )
  );

  await roots.start('!room:example.org');
  expect([...roots.activity.keys()]).toEqual(['$active:example.test']);

  roots.markRootRead('$active:example.test');
  expect([...roots.activity.keys()]).toEqual([]);
  roots.stop();
});

test('background refresh keeps existing items visible without flashing loading state', async () => {
  vi.useFakeTimers();
  const { core, roots } = fixture();
  const first = timelineItem('first', 'First topic');
  const updated = timelineItem('first', 'Updated topic');
  const nextRefresh = Promise.withResolvers<{
    roots: (typeof first)[];
    next_batch: string | null;
  }>();
  core.rpc.timeline.listThreads
    .mockResolvedValueOnce({ roots: [first], next_batch: null })
    .mockImplementationOnce(() => nextRefresh.promise);

  await roots.start('!room:example.org');
  expect(roots.loading).toBe(false);
  expect(roots.items.map((root) => root.id)).toEqual(['first']);

  roots.refresh();
  await vi.advanceTimersByTimeAsync(250);
  expect(core.rpc.timeline.listThreads).toHaveBeenCalledTimes(2);
  expect(roots.loading).toBe(false);
  expect(roots.items).toEqual([first]);

  nextRefresh.resolve({ roots: [updated], next_batch: null });
  await Promise.resolve();
  expect(roots.loading).toBe(false);
  expect(roots.items).toEqual([updated]);
  roots.stop();
});
