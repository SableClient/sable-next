import { expect, test } from 'vitest';

import type { CoreEvent } from '@/generated/CoreEvent';
import type { TimelineItemView } from '@/generated/TimelineItemView';
import type { CoreClient } from '$lib/core/client.svelte';

import { RoomTimeline } from './timeline.svelte';

type TimelineDiffEvent = Extract<CoreEvent, { type: 'timeline_diff' }>;

function item(id: string): TimelineItemView {
  return {
    id,
    event_id: `$${id}`,
    transaction_id: null,
    send_state: null,
    sender: '@alice:example.org',
    sender_name: 'Alice',
    sender_avatar: null,
    timestamp: 0,
    content: { kind: 'message', body: id, formatted: null, edited: false },
    in_reply_to: null,
    thread_root: null,
    thread_summary: null,
    reactions: [],
    is_own: false,
    read_by: [],
  };
}

class FakeCore {
  private readonly listeners = new Set<(event: CoreEvent) => void>();
  paginateCalls = 0;
  paginateSubscriptions: number[] = [];
  subscribeCalls: Array<{ roomId: string; eventId: string | null }> = [];

  subscribeEvents(listener: (event: CoreEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeTimeline(roomId: string, eventId: string | null) {
    this.subscribeCalls.push({ roomId, eventId });
    this.emit({
      type: 'timeline_diff',
      subscription: 1,
      diffs: [{ op: 'push_back', value: item('buffered') }],
    });
    return Promise.resolve({ subscription: 1, items: [item('initial')] });
  }

  paginate(subscription: number) {
    this.paginateCalls += 1;
    this.paginateSubscriptions.push(subscription);
    this.emit({
      type: 'timeline_diff',
      subscription,
      diffs: [{ op: 'push_front', value: item('history') }],
    });
    return Promise.resolve({ reached_start: true });
  }

  async unsubscribe() {}

  emit(event: TimelineDiffEvent) {
    for (const listener of this.listeners) listener(event);
  }
}

test('preserves buffered diffs and appends live messages', async () => {
  const core = new FakeCore();
  const timeline = new RoomTimeline(core as unknown as CoreClient);

  await timeline.start('!room:example.org');

  expect(core.paginateCalls).toBe(0);
  expect(core.subscribeCalls).toEqual([{ roomId: '!room:example.org', eventId: null }]);
  expect(timeline.backwardPagination).toBe('idle');
  expect(timeline.items.map((entry) => entry.id)).toEqual(['initial', 'buffered']);

  core.emit({
    type: 'timeline_diff',
    subscription: 1,
    diffs: [{ op: 'push_back', value: item('live') }],
  });

  expect(timeline.items.map((entry) => entry.id)).toEqual(['initial', 'buffered', 'live']);
});

test('opens a permalink as a focused timeline without live pagination', async () => {
  const core = new FakeCore();
  const timeline = new RoomTimeline(core as unknown as CoreClient);

  await timeline.start('!room:example.org', '$target');

  expect(core.subscribeCalls).toEqual([{ roomId: '!room:example.org', eventId: '$target' }]);
  expect(core.paginateCalls).toBe(0);
  expect(timeline.items.map((entry) => entry.id)).toEqual(['initial', 'buffered']);
});

test('paginates the SDK timeline that owns the subscription', async () => {
  const core = new FakeCore();
  const timeline = new RoomTimeline(core as unknown as CoreClient);
  await timeline.start('!room:example.org');

  await timeline.paginate(25);

  expect(core.paginateSubscriptions).toEqual([1]);
  expect(timeline.backwardPagination).toBe('end');
  expect(timeline.items.map((entry) => entry.id)).toEqual(['history', 'initial', 'buffered']);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

class PendingPaginationCore extends FakeCore {
  readonly pendingPagination = deferred<{ reached_start: boolean }>();

  override paginate(subscription: number) {
    this.paginateCalls += 1;
    this.paginateSubscriptions.push(subscription);
    return this.pendingPagination.promise;
  }
}

test('coalesces pagination and ignores completion after stop', async () => {
  const core = new PendingPaginationCore();
  const timeline = new RoomTimeline(core as unknown as CoreClient);
  await timeline.start('!room:example.org');

  const first = timeline.paginate(25);
  await timeline.paginate(25);
  expect(core.paginateSubscriptions).toEqual([1]);
  expect(timeline.backwardPagination).toBe('loading');

  timeline.stop();
  core.pendingPagination.resolve({ reached_start: true });
  await first;
  expect(timeline.backwardPagination).toBe('idle');
  expect(timeline.items).toEqual([]);
});

class SwitchingCore {
  private readonly listeners = new Set<(event: CoreEvent) => void>();
  readonly responses = new Map<
    string,
    ReturnType<typeof deferred<{ subscription: number; items: TimelineItemView[] }>>
  >();
  readonly unsubscribed: number[] = [];

  subscribeEvents(listener: (event: CoreEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeTimeline(roomId: string) {
    const response = deferred<{ subscription: number; items: TimelineItemView[] }>();
    this.responses.set(roomId, response);
    return response.promise;
  }

  unsubscribe(subscription: number) {
    this.unsubscribed.push(subscription);
    return Promise.resolve();
  }
}

test('a late room subscription cannot replace the current room', async () => {
  const core = new SwitchingCore();
  const timeline = new RoomTimeline(core as unknown as CoreClient);

  const firstStart = timeline.start('!first:example.org');
  timeline.stop();
  const secondStart = timeline.start('!second:example.org');

  const secondResponse = core.responses.get('!second:example.org');
  if (!secondResponse) throw new Error('second subscription was not created');
  secondResponse.resolve({ subscription: 2, items: [item('second')] });
  await secondStart;
  const firstResponse = core.responses.get('!first:example.org');
  if (!firstResponse) throw new Error('first subscription was not created');
  firstResponse.resolve({ subscription: 1, items: [item('first')] });
  await firstStart;

  expect(timeline.items.map((entry) => entry.id)).toEqual(['second']);
  expect(core.unsubscribed).toEqual([1]);
});
