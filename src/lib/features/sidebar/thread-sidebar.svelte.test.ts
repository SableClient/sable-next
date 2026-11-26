// @vitest-environment happy-dom

import { afterEach, expect, test, vi } from 'vitest';
import type { CoreClient } from '#lib/core/client.svelte.js';
import { createCoreStub } from '#lib/core/__mocks__/context.js';
import { timelineItem } from '../../../../tests/e2e/fixtures/timeline-items';

import { settleFirstRoom } from '#lib/rooms/first-room-gate.js';
import { THREAD_ACTIVITY_WINDOW } from '#lib/rooms/thread-roots.svelte.js';
import { clearThreadRepliesCache } from '#lib/rooms/thread-replies.js';
import { setPreference } from '#lib/settings/preferences.svelte.js';
import { ThreadSidebar } from './thread-sidebar.svelte.js';

settleFirstRoom();

afterEach(() => {
  clearThreadRepliesCache();
  setPreference('showActiveThreadsInSidebar', true);
  vi.useRealTimers();
});

const room = '!room:example.org';

function activeThread(id: string, title: string, latestTimestamp: number, participated = true) {
  return {
    ...timelineItem(id, title),
    timestamp: latestTimestamp,
    thread_summary: {
      num_replies: 2,
      latest_event_id: `$${id}-reply:example.test`,
      latest_timestamp: latestTimestamp,
      latest_sender: '@bob:example.test',
      current_user_participated: participated,
      latest_body: 'Reply',
      latest_fallback: null,
      latest_emotes: [],
    },
  };
}

async function withSidebar(
  setup: (core: ReturnType<typeof createCoreStub>) => void,
  run: (core: ReturnType<typeof createCoreStub>, sidebar: ThreadSidebar) => Promise<void>
): Promise<void> {
  const core = createCoreStub();
  setup(core);
  const sidebar = new ThreadSidebar(core as unknown as CoreClient);
  sidebar.start();
  try {
    await run(core, sidebar);
  } finally {
    sidebar.stop();
  }
}

test('personal pins survive the activity cutoff and only recent participation adds a row', async () => {
  vi.useFakeTimers();
  const now = Date.now();
  const pinned = {
    ...timelineItem('pinned', 'Pinned topic'),
    timestamp: now - THREAD_ACTIVITY_WINDOW - 1,
  };
  const active = activeThread('active', 'Active topic', now - THREAD_ACTIVITY_WINDOW + 50);
  const nonParticipated = {
    ...activeThread('other', 'Other topic', now - 500, false),
    sender: '@bob:example.test',
    is_own: false,
  };
  const old = { ...timelineItem('old', 'Old topic'), timestamp: now - THREAD_ACTIVITY_WINDOW - 1 };

  await withSidebar(
    (core) => {
      core.rpc.account.threadSidebar.mockResolvedValue({
        pins: [{ room_id: room, event_id: pinned.event_id ?? '' }],
        dismissed: [],
      });
      core.rpc.account.setThreadPin.mockResolvedValue({ pins: [], dismissed: [] });
      core.rpc.timeline.eventItems.mockResolvedValue([pinned]);
      core.rpc.timeline.listThreads.mockResolvedValue({
        roots: [active, nonParticipated, old],
        next_batch: null,
      });
    },
    async (core, sidebar) => {
      sidebar.discover(room, 'first');
      await vi.advanceTimersByTimeAsync(0);

      expect(core.rpc.timeline.listThreads).toHaveBeenCalledExactlyOnceWith({
        room_id: room,
        from: null,
        participated: true,
      });
      expect(sidebar.rows(room).map(({ title, pinned: isPinned }) => [title, isPinned])).toEqual([
        ['Pinned topic', true],
        ['Active topic', false],
      ]);

      await vi.advanceTimersByTimeAsync(50);
      expect(sidebar.rows(room).map(({ title }) => title)).toEqual(['Pinned topic']);

      await sidebar.togglePin(room, '$pinned:example.test');
      expect(core.rpc.account.setThreadPin).toHaveBeenCalledExactlyOnceWith({
        room_id: room,
        event_id: '$pinned:example.test',
        pinned: false,
      });
      expect(sidebar.rows(room)).toEqual([]);
    }
  );
});

test('showActiveThreadsInSidebar keeps only pins and skips active discovery until re-enabled', async () => {
  vi.useFakeTimers();
  const now = Date.now();
  const pinned = {
    ...timelineItem('pinned', 'Pinned topic'),
    timestamp: now - THREAD_ACTIVITY_WINDOW - 1,
  };
  const active = activeThread('active', 'Active topic', now - 500);
  setPreference('showActiveThreadsInSidebar', false);

  await withSidebar(
    (core) => {
      core.rpc.account.threadSidebar.mockResolvedValue({
        pins: [{ room_id: room, event_id: pinned.event_id ?? '' }],
        dismissed: [],
      });
      core.rpc.timeline.eventItems.mockResolvedValue([pinned]);
      core.rpc.timeline.listThreads.mockResolvedValue({ roots: [active], next_batch: null });
    },
    async (core, sidebar) => {
      sidebar.discover(room, 'first');
      await vi.advanceTimersByTimeAsync(0);

      expect(core.rpc.timeline.listThreads).not.toHaveBeenCalled();
      expect(sidebar.rows(room).map(({ title, pinned: isPinned }) => [title, isPinned])).toEqual([
        ['Pinned topic', true],
      ]);

      setPreference('showActiveThreadsInSidebar', true);
      sidebar.discover(room, 'first');
      await vi.advanceTimersByTimeAsync(0);

      expect(core.rpc.timeline.listThreads).toHaveBeenCalledTimes(1);
      expect(sidebar.rows(room).map(({ title, pinned: isPinned }) => [title, isPinned])).toEqual([
        ['Pinned topic', true],
        ['Active topic', false],
      ]);
    }
  );
});

test('dismissing a participated thread hides it until restored by un-dismiss, pin, or reply', async () => {
  vi.useFakeTimers();
  const now = Date.now();
  const active = activeThread('active', 'Active topic', now - 500);
  const ref = { room_id: room, event_id: '$active:example.test' };

  await withSidebar(
    (core) => {
      core.rpc.account.threadSidebar.mockResolvedValue({ pins: [], dismissed: [] });
      core.rpc.account.setThreadDismissed.mockImplementation(({ dismissed }) =>
        Promise.resolve({ pins: [], dismissed: dismissed ? [ref] : [] })
      );
      core.rpc.account.setThreadPin.mockImplementation(({ pinned }) =>
        Promise.resolve({ pins: pinned ? [ref] : [], dismissed: [] })
      );
      core.rpc.timeline.listThreads.mockResolvedValue({ roots: [active], next_batch: null });
    },
    async (core, sidebar) => {
      sidebar.discover(room, 'r1');
      await vi.advanceTimersByTimeAsync(0);
      expect(sidebar.isAutoListed(room, '$active:example.test')).toBe(true);
      expect(sidebar.rows(room).map(({ id }) => id)).toEqual(['$active:example.test']);

      await sidebar.setDismissed(room, '$active:example.test', true);
      expect(sidebar.isDismissed(room, '$active:example.test')).toBe(true);
      expect(sidebar.isAutoListed(room, '$active:example.test')).toBe(false);
      expect(sidebar.rows(room)).toEqual([]);

      sidebar.discover(room, 'r2');
      await vi.advanceTimersByTimeAsync(0);
      expect(sidebar.rows(room)).toEqual([]);

      await sidebar.setDismissed(room, '$active:example.test', false);
      expect(sidebar.isDismissed(room, '$active:example.test')).toBe(false);
      expect(sidebar.rows(room).map(({ id }) => id)).toEqual(['$active:example.test']);

      await sidebar.setDismissed(room, '$active:example.test', true);
      expect(sidebar.rows(room)).toEqual([]);

      sidebar.noteReply(room, '$active:example.test', active);
      await vi.advanceTimersByTimeAsync(0);
      expect(core.rpc.account.setThreadDismissed).toHaveBeenLastCalledWith({
        room_id: room,
        event_id: '$active:example.test',
        dismissed: false,
      });
      expect(sidebar.rows(room).map(({ id }) => id)).toEqual(['$active:example.test']);

      await sidebar.setDismissed(room, '$active:example.test', true);
      await sidebar.togglePin(room, '$active:example.test');
      expect(sidebar.hasPin(room, '$active:example.test')).toBe(true);
      expect(sidebar.isDismissed(room, '$active:example.test')).toBe(false);
      expect(sidebar.rows(room).map(({ id, pinned }) => [id, pinned])).toEqual([
        ['$active:example.test', true],
      ]);
    }
  );
});

test('pinning updates optimistically without blocking other threads and rolls back on failure', async () => {
  const refA = { room_id: room, event_id: '$a:example.test' };
  const refB = { room_id: room, event_id: '$b:example.test' };
  const firstRpc = Promise.withResolvers<{ pins: (typeof refA)[]; dismissed: [] }>();
  const secondRpc = Promise.withResolvers<{ pins: (typeof refA)[]; dismissed: [] }>();
  const rollbackRpc = Promise.withResolvers<{ pins: (typeof refA)[]; dismissed: [] }>();

  await withSidebar(
    (core) => {
      core.rpc.account.threadSidebar.mockResolvedValue({ pins: [], dismissed: [] });
      core.rpc.account.setThreadPin
        .mockImplementationOnce(() => firstRpc.promise)
        .mockImplementationOnce(() => secondRpc.promise)
        .mockImplementationOnce(() => rollbackRpc.promise);
    },
    async (core, sidebar) => {
      await Promise.resolve();
      const first = sidebar.togglePin(room, refA.event_id);
      expect(sidebar.hasPin(room, refA.event_id)).toBe(true);

      const second = sidebar.togglePin(room, refB.event_id);
      expect(sidebar.hasPin(room, refA.event_id)).toBe(true);
      expect(sidebar.hasPin(room, refB.event_id)).toBe(true);
      await Promise.resolve();
      expect(core.rpc.account.setThreadPin).toHaveBeenCalledTimes(1);

      firstRpc.resolve({ pins: [refA], dismissed: [] });
      await first;
      expect(sidebar.hasPin(room, refB.event_id)).toBe(true);
      expect(core.rpc.account.setThreadPin).toHaveBeenCalledTimes(2);

      secondRpc.resolve({ pins: [refA, refB], dismissed: [] });
      await second;
      expect(sidebar.hasPin(room, refA.event_id)).toBe(true);
      expect(sidebar.hasPin(room, refB.event_id)).toBe(true);

      const fail = sidebar.togglePin(room, refA.event_id);
      expect(sidebar.hasPin(room, refA.event_id)).toBe(false);
      rollbackRpc.reject(new Error('network error'));
      await expect(fail).rejects.toThrow('network error');
      expect(sidebar.hasPin(room, refA.event_id)).toBe(true);
      expect(sidebar.hasPin(room, refB.event_id)).toBe(true);
    }
  );
});
