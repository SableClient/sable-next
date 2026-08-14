import { expect, test, vi } from 'vitest';

import type { CoreEvent } from '@/generated/CoreEvent';
import type { TimelineItemView } from '@/generated/TimelineItemView';
import type { CoreClient } from '$lib/core/client.svelte';

import { RoomTimeline } from './timeline.svelte';

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
    content: { kind: 'message', body: id, html: id, emote: false, edited: false },
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

  paginate(
    subscription: number,
    direction: 'backward' | 'forward'
  ): Promise<{
    direction: 'backward' | 'forward';
    reached_end: boolean;
  }> {
    this.paginateCalls += 1;
    this.paginateSubscriptions.push(subscription);
    this.emit({
      type: 'timeline_pagination',
      subscription,
      loading: false,
      reached_start: true,
    });
    this.emit({
      type: 'timeline_diff',
      subscription,
      diffs: [{ op: 'push_front', value: item('history') }],
    });
    return Promise.resolve({ direction, reached_end: true });
  }

  async unsubscribe() {}

  emit(event: CoreEvent) {
    for (const listener of this.listeners) listener(event);
  }
}

test('requests live context as part of its snapshot subscription', async () => {
  const core = new FakeCore();
  const timeline = new RoomTimeline(core as unknown as CoreClient);

  await timeline.start('!room:example.org');

  expect(core.paginateCalls).toBe(0);
  expect(core.subscribeCalls).toEqual([{ roomId: '!room:example.org', eventId: null }]);
  expect(timeline.items.map((entry) => entry.id)).toEqual(['initial']);

  core.emit({
    type: 'timeline_diff',
    subscription: 1,
    diffs: [{ op: 'push_back', value: item('live') }],
  });

  expect(timeline.items.map((entry) => entry.id)).toEqual(['initial', 'live']);
});

test('opens a permalink as a focused timeline without live pagination', async () => {
  const core = new FakeCore();
  const timeline = new RoomTimeline(core as unknown as CoreClient);

  await timeline.start('!room:example.org', '$target');

  expect(core.subscribeCalls).toEqual([{ roomId: '!room:example.org', eventId: '$target' }]);
  expect(core.paginateCalls).toBe(0);
  expect(timeline.items.map((entry) => entry.id)).toEqual(['initial']);
  expect(timeline.mode).toEqual({ kind: 'focused', eventId: '$target' });
});

test('ignores live pagination status for a focused timeline', async () => {
  const core = new FakeCore();
  const timeline = new RoomTimeline(core as unknown as CoreClient);
  await timeline.start('!room:example.org', '$target');

  core.emit({ type: 'timeline_pagination', subscription: 1, loading: true, reached_start: false });

  expect(timeline.backwardPagination).toBe('idle');
});

test('paginates a focused timeline forwards independently', async () => {
  const core = new FakeCore();
  const timeline = new RoomTimeline(core as unknown as CoreClient);
  await timeline.start('!room:example.org', '$target');

  await timeline.paginateForward(25);

  expect(core.paginateSubscriptions).toEqual([1]);
  expect(timeline.forwardPagination).toBe('end');
});

test('does not resubscribe when started again for the same room', async () => {
  const core = new FakeCore();
  const timeline = new RoomTimeline(core as unknown as CoreClient);

  await timeline.start('!room:example.org');
  await timeline.start('!room:example.org');

  expect(core.subscribeCalls).toEqual([{ roomId: '!room:example.org', eventId: null }]);
  expect(core.paginateCalls).toBe(0);
});

test('paginates the SDK timeline that owns the subscription', async () => {
  const core = new FakeCore();
  const timeline = new RoomTimeline(core as unknown as CoreClient);
  await timeline.start('!room:example.org');

  await timeline.paginateBackward(25);

  expect(core.paginateSubscriptions).toEqual([1]);
  expect(timeline.backwardPagination).toBe('end');
  expect(timeline.items.map((entry) => entry.id)).toEqual(['history', 'initial']);
});

class DelayedDiffCore extends FakeCore {
  override subscribeTimeline(roomId: string, eventId: string | null) {
    this.subscribeCalls.push({ roomId, eventId });
    this.emit({
      type: 'timeline_pagination',
      subscription: 1,
      loading: false,
      reached_start: false,
    });
    return Promise.resolve({ subscription: 1, items: [item('latest')] });
  }

  override paginate(subscription: number, direction: 'backward' | 'forward') {
    this.paginateCalls += 1;
    this.paginateSubscriptions.push(subscription);
    this.emit({ type: 'timeline_pagination', subscription, loading: true, reached_start: false });
    this.emit({ type: 'timeline_pagination', subscription, loading: false, reached_start: false });
    return Promise.resolve({ direction, reached_end: false });
  }
}

test('applies a delayed initial history diff after pagination settles', async () => {
  const core = new DelayedDiffCore();
  const timeline = new RoomTimeline(core as unknown as CoreClient);

  await timeline.start('!room:example.org');
  expect(timeline.backwardPagination).toBe('idle');
  expect(timeline.items.map((entry) => entry.id)).toEqual(['latest']);

  core.emit({
    type: 'timeline_diff',
    subscription: 1,
    diffs: [
      { op: 'insert', index: 0, value: item('history-1') },
      { op: 'insert', index: 1, value: item('history-2') },
    ],
  });

  expect(timeline.items.map((entry) => entry.id)).toEqual(['history-1', 'history-2', 'latest']);
});

class EventSettledPaginationCore extends FakeCore {
  override paginate(subscription: number, direction: 'backward' | 'forward') {
    this.paginateCalls += 1;
    this.paginateSubscriptions.push(subscription);
    this.emit({ type: 'timeline_pagination', subscription, loading: true, reached_start: false });
    return Promise.resolve({ direction, reached_end: false });
  }
}

test('settles live pagination when the oldest event changes after the response', async () => {
  const core = new EventSettledPaginationCore();
  const timeline = new RoomTimeline(core as unknown as CoreClient);
  await timeline.start('!room:example.org');

  await timeline.paginateBackward(25);
  expect(timeline.backwardPagination).toBe('loading');

  core.emit({
    type: 'timeline_diff',
    subscription: 1,
    diffs: [{ op: 'push_front', value: item('history') }],
  });
  core.emit({
    type: 'timeline_pagination',
    subscription: 1,
    loading: false,
    reached_start: false,
  });

  expect(timeline.backwardPagination).toBe('idle');
  expect(timeline.items.map((entry) => entry.id)).toEqual(['history', 'initial']);
});

class UnchangedPaginationCore extends EventSettledPaginationCore {
  override paginate(subscription: number, direction: 'backward' | 'forward') {
    this.paginateCalls += 1;
    this.paginateSubscriptions.push(subscription);
    return Promise.resolve({ direction, reached_end: false });
  }
}

test('settles an unchanged live page after the diff fallback timeout', async () => {
  vi.useFakeTimers();
  try {
    const core = new UnchangedPaginationCore();
    const timeline = new RoomTimeline(core as unknown as CoreClient);
    await timeline.start('!room:example.org');

    await timeline.paginateBackward(25);
    expect(timeline.backwardPagination).toBe('loading');
    await vi.advanceTimersByTimeAsync(2_000);

    expect(timeline.backwardPagination).toBe('idle');
  } finally {
    vi.useRealTimers();
  }
});

class ReachedEndPaginationCore extends EventSettledPaginationCore {
  override paginate(subscription: number, direction: 'backward' | 'forward') {
    this.paginateCalls += 1;
    this.paginateSubscriptions.push(subscription);
    return Promise.resolve({ direction, reached_end: true });
  }
}

test('settles a reached-end live page without waiting for a diff', async () => {
  const core = new ReachedEndPaginationCore();
  const timeline = new RoomTimeline(core as unknown as CoreClient);
  await timeline.start('!room:example.org');

  await expect(timeline.paginateBackward(25)).resolves.toBe(true);

  expect(timeline.backwardPagination).toBe('end');
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

class PendingPaginationCore extends FakeCore {
  readonly pendingPagination = deferred<{ reached_end: boolean }>();

  override paginate(subscription: number, direction: 'backward' | 'forward') {
    this.paginateCalls += 1;
    this.paginateSubscriptions.push(subscription);
    return this.pendingPagination.promise.then((response) => ({ direction, ...response }));
  }
}

test('settles live pagination when the oldest event changes before the response', async () => {
  const core = new PendingPaginationCore();
  const timeline = new RoomTimeline(core as unknown as CoreClient);
  await timeline.start('!room:example.org');

  const pagination = timeline.paginateBackward(25);
  core.emit({
    type: 'timeline_diff',
    subscription: 1,
    diffs: [{ op: 'push_front', value: item('history') }],
  });
  expect(timeline.backwardPagination).toBe('loading');

  core.pendingPagination.resolve({ reached_end: false });
  await pagination;

  expect(timeline.backwardPagination).toBe('idle');
  expect(timeline.items.map((entry) => entry.id)).toEqual(['history', 'initial']);
});

test('coalesces pagination and ignores completion after stop', async () => {
  const core = new PendingPaginationCore();
  const timeline = new RoomTimeline(core as unknown as CoreClient);
  const start = timeline.start('!room:example.org', '$event:example.org');
  await Promise.resolve();

  const first = timeline.paginateBackward(25);
  await timeline.paginateBackward(25);
  expect(core.paginateSubscriptions).toEqual([1]);
  expect(timeline.backwardPagination).toBe('loading');

  void timeline.stop();
  core.pendingPagination.resolve({ reached_end: true });
  await start;
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
  readonly paginateSubscriptions: number[] = [];

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

  paginate(subscription: number, direction: 'backward' | 'forward') {
    this.paginateSubscriptions.push(subscription);
    return Promise.resolve({ direction, reached_end: true });
  }

  emit(event: CoreEvent) {
    for (const listener of this.listeners) listener(event);
  }
}

test('a late room subscription cannot replace the current room', async () => {
  const core = new SwitchingCore();
  const timeline = new RoomTimeline(core as unknown as CoreClient);

  const firstStart = timeline.start('!first:example.org');
  void timeline.stop();
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

test('waits for the previous unsubscribe before replacing a timeline subscription', async () => {
  const unsubscribe = deferred<undefined>();
  class SerializedCore extends FakeCore {
    override unsubscribe() {
      return unsubscribe.promise;
    }
  }
  const core = new SerializedCore();
  const timeline = new RoomTimeline(core as unknown as CoreClient);
  await timeline.start('!first:example.org');

  const next = timeline.start('!second:example.org');
  await Promise.resolve();
  expect(core.subscribeCalls).toEqual([{ roomId: '!first:example.org', eventId: null }]);

  unsubscribe.resolve(undefined);
  await next;
  expect(core.subscribeCalls).toEqual([
    { roomId: '!first:example.org', eventId: null },
    { roomId: '!second:example.org', eventId: null },
  ]);
});

test('a delayed stale start cannot paginate the active timeline', async () => {
  const core = new SwitchingCore();
  const timeline = new RoomTimeline(core as unknown as CoreClient);

  const firstStart = timeline.start('!first:example.org');
  void timeline.stop();
  const secondStart = timeline.start('!second:example.org', '$event:example.org');

  const secondResponse = core.responses.get('!second:example.org');
  if (!secondResponse) throw new Error('second subscription was not created');
  secondResponse.resolve({ subscription: 2, items: [item('second')] });
  await secondStart;

  const firstResponse = core.responses.get('!first:example.org');
  if (!firstResponse) throw new Error('first subscription was not created');
  firstResponse.resolve({ subscription: 1, items: [item('first')] });
  await firstStart;

  expect(core.paginateSubscriptions).toEqual([]);
});

test('ignores events that precede the subscription snapshot', async () => {
  const core = new SwitchingCore();
  const timeline = new RoomTimeline(core as unknown as CoreClient);

  const start = timeline.start('!room:example.org', '$event:example.org');
  core.emit({ type: 'timeline_pagination', subscription: 1, loading: true, reached_start: false });
  core.emit({ type: 'timeline_pagination', subscription: 2, loading: false, reached_start: true });

  const response = core.responses.get('!room:example.org');
  if (!response) throw new Error('subscription was not created');
  response.resolve({ subscription: 1, items: [item('initial')] });
  await start;

  expect(timeline.backwardPagination).toBe('idle');
});
