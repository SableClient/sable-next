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
      latest_body: 'Old reply',
      latest_fallback: null,
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
