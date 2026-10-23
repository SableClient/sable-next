import { expect, test, vi } from 'vitest';

import type { CoreEvent, TimelineFocusView, TimelineItemView } from '#src/generated/protocol';
import type { CoreClient } from '#lib/core/client.svelte.js';

import { RoomTimeline } from './timeline.svelte';
import { withRowFields } from '#lib/features/room/timeline/row-fixtures.js';

function item(id: string): TimelineItemView {
  return withRowFields({
    id,
    event_id: `$${id}`,
    transaction_id: null,
    send_state: null,
    sender: '@alice:example.org',
    sender_name: 'Alice',
    sender_avatar: null,
    timestamp: 0,
    content: {
      kind: 'message',
      body: id,
      html: id,
      emote: false,
      notice: false,
      edited: false,
      jumbo: null,
    },
    in_reply_to: null,
    thread_root: null,
    thread_summary: null,
    reactions: [],
    is_own: false,
    read_by: [],
    read_timestamps: {},
    per_message_profile: null,
    bundled_link_previews: [],
    link_previews_removed: null,
    mention: 'none',
    forwarded: null,
    forum_title: null,
  });
}

class FakeCore {
  private readonly listeners = new Set<(event: CoreEvent) => void>();
  paginateCalls = 0;
  paginateSubscriptions: number[] = [];
  subscribeCalls: Array<{ roomId: string; focus: TimelineFocusView }> = [];

  readMarker(_roomId: string): Promise<string | null> {
    return Promise.resolve('$read');
  }

  subscribeEvents(listener: (event: CoreEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeTimeline(roomId: string, focus: TimelineFocusView) {
    this.subscribeCalls.push({ roomId, focus });
    return Promise.resolve({ subscription: 1, items: [item('initial')], aggregations: [] });
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
      diffs: [
        direction === 'forward'
          ? { PushBack: { value: item('history') } }
          : { PushFront: { value: item('history') } },
      ],
    });
    return Promise.resolve({ direction, reached_end: true });
  }

  async unsubscribe() {}

  emit(event: CoreEvent) {
    for (const listener of this.listeners) listener(event);
  }

  get rpc() {
    return {
      timeline: {
        subscribe: (params: { room_id: string; focus: TimelineFocusView }) =>
          this.subscribeTimeline(params.room_id, params.focus),
        paginate: (params: { subscription: number; direction: 'backward' | 'forward' }) =>
          this.paginate(params.subscription, params.direction),
        unsubscribe: () => this.unsubscribe(),
        readMarker: (params: { room_id: string }) => this.readMarker(params.room_id),
      },
    };
  }
}

test('requests live context as part of its snapshot subscription', async () => {
  const core = new FakeCore();
  const timeline = new RoomTimeline(core as unknown as CoreClient);

  expect(timeline.hasSnapshot).toBe(false);
  await timeline.start('!room:example.org');

  expect(timeline.hasSnapshot).toBe(true);
  expect(core.paginateCalls).toBe(0);
  expect(core.subscribeCalls).toEqual([{ roomId: '!room:example.org', focus: { kind: 'live' } }]);
  expect(timeline.items.map((entry) => entry.id)).toEqual(['initial']);

  core.emit({
    type: 'timeline_diff',
    subscription: 1,
    diffs: [{ PushBack: { value: item('live') } }],
  });

  expect(timeline.items.map((entry) => entry.id)).toEqual(['initial', 'live']);
  await timeline.stop();
  expect(timeline.hasSnapshot).toBe(false);
});

test('a reload drops the aggregations older than what it kept, and a page brings them back', async () => {
  const core = new FakeCore();
  const timeline = new RoomTimeline(core as unknown as CoreClient);
  await timeline.start('!room:example.org');
  const at = (id: string, timestamp: number) => ({ ...item(id), timestamp });
  const old = at('old-reaction', 5);
  core.emit({
    type: 'timeline_aggregations',
    subscription: 1,
    items: [old, at('new-reaction', 50)],
  });

  core.emit({
    type: 'timeline_diff',
    subscription: 1,
    diffs: [{ Clear: {} }, { Append: { values: [at('kept', 20)] } }],
  });
  expect(timeline.aggregations.map((entry) => entry.id)).toEqual(['new-reaction']);

  core.emit({
    type: 'timeline_diff',
    subscription: 1,
    diffs: [{ PushFront: { value: at('page', 1) } }],
  });
  core.emit({ type: 'timeline_aggregations', subscription: 1, items: [old] });
  expect(timeline.aggregations.map((entry) => entry.id)).toEqual(['new-reaction', 'old-reaction']);
});

test('an updated aggregation replaces the previous version of the event', async () => {
  const core = new FakeCore();
  const timeline = new RoomTimeline(core as unknown as CoreClient);
  await timeline.start('!room:example.org');
  const reaction = withRowFields({
    ...item('reaction'),
    content: {
      kind: 'hidden_event',
      event_type: 'm.reaction',
      content: { 'm.relates_to': { event_id: '$initial', key: '👍', rel_type: 'm.annotation' } },
      redacts: null,
    },
  }) as TimelineItemView;
  const redacted = {
    ...reaction,
    content: { kind: 'hidden_event', event_type: 'm.reaction', content: {}, redacts: null },
  } as TimelineItemView;

  core.emit({ type: 'timeline_aggregations', subscription: 1, items: [reaction] });
  core.emit({ type: 'timeline_aggregations', subscription: 1, items: [redacted] });

  expect(timeline.aggregations).toEqual([redacted]);
});

test('opens a permalink as a focused timeline without live pagination', async () => {
  const core = new FakeCore();
  const timeline = new RoomTimeline(core as unknown as CoreClient);

  await timeline.start('!room:example.org', '$target');

  expect(core.subscribeCalls).toEqual([
    { roomId: '!room:example.org', focus: { kind: 'event', event_id: '$target' } },
  ]);
  expect(core.paginateCalls).toBe(0);
  expect(timeline.items.map((entry) => entry.id)).toEqual(['initial']);
  expect(timeline.mode).toEqual({ kind: 'focused', eventId: '$target' });
});

test('opens unread at its marker without paginating through the backlog', async () => {
  const core = new FakeCore();
  const timeline = new RoomTimeline(core as unknown as CoreClient);
  await timeline.start('!room:example.org', null, false, true);
  expect(core.subscribeCalls).toEqual([
    { roomId: '!room:example.org', focus: { kind: 'live' } },
    { roomId: '!room:example.org', focus: { kind: 'event', event_id: '$read' } },
  ]);
  expect(core.paginateCalls).toBe(0);
  expect(timeline.mode).toEqual({ kind: 'unread', eventId: '$read' });
  await timeline.paginateForward(25);
  expect(timeline.forwardPagination).toBe('end');
  await timeline.resumeLive();
  expect(core.subscribeCalls.at(-1)?.focus).toEqual({ kind: 'live' });
});

test('an unread marker outside the snapshot opens its context without paging', async () => {
  const core = new FakeCore();
  const timeline = new RoomTimeline(core as unknown as CoreClient);
  await timeline.start('!room:example.org', null, false, true);
  expect(core.subscribeCalls.map((call) => call.focus)).toEqual([
    { kind: 'live' },
    { kind: 'event', event_id: '$read' },
  ]);
  expect(core.paginateCalls).toBe(0);
  expect(timeline.mode).toEqual({ kind: 'unread', eventId: '$read' });
});

test('a notified event outside the live snapshot opens its context without paging', async () => {
  const core = new FakeCore();
  const timeline = new RoomTimeline(core as unknown as CoreClient);
  await timeline.start('!room:example.org', null, false, false, '$notified');
  expect(core.subscribeCalls.map((call) => call.focus)).toEqual([
    { kind: 'live' },
    { kind: 'event', event_id: '$notified' },
  ]);
  expect(core.paginateCalls).toBe(0);
  expect(timeline.mode).toEqual({ kind: 'unread', eventId: '$notified' });
});

test('a notified event in the live snapshot keeps the live timeline', async () => {
  const core = new FakeCore();
  const timeline = new RoomTimeline(core as unknown as CoreClient);
  await timeline.start('!room:example.org', null, false, false, '$initial');
  expect(core.subscribeCalls.map((call) => call.focus)).toEqual([{ kind: 'live' }]);
  expect(timeline.mode).toEqual({ kind: 'live' });
});

test('requesting the context that is already open does not resubscribe', async () => {
  const core = new FakeCore();
  const timeline = new RoomTimeline(core as unknown as CoreClient);
  await timeline.start('!room:example.org', null, false, false, '$notified');
  await timeline.startUnread('!room:example.org', '$notified');
  expect(core.subscribeCalls).toHaveLength(2);
  expect(timeline.mode).toEqual({ kind: 'unread', eventId: '$notified' });
});

test('repeating the room opening after a summary update keeps its unread context', async () => {
  const core = new FakeCore();
  const timeline = new RoomTimeline(core as unknown as CoreClient);
  await timeline.start('!room:example.org', null, false, true);
  await timeline.start('!room:example.org', null, false, false);
  expect(core.subscribeCalls).toHaveLength(2);
  expect(timeline.mode.kind).toBe('unread');
});

test('returning from unread opens live at its latest messages without paging', async () => {
  const core = new FakeCore();
  vi.spyOn(core, 'subscribeTimeline')
    .mockResolvedValueOnce({ subscription: 1, items: [item('end')], aggregations: [] })
    .mockResolvedValueOnce({
      subscription: 2,
      items: [item('read'), item('anchor')],
      aggregations: [],
    })
    .mockResolvedValueOnce({
      subscription: 3,
      items: [item('end'), item('arrived')],
      aggregations: [],
    });
  const paginate = vi.spyOn(core, 'paginate');
  const timeline = new RoomTimeline(core as unknown as CoreClient);
  await timeline.start('!room:example.org', null, false, true);

  await timeline.resumeLive();

  expect(paginate).not.toHaveBeenCalled();
  expect(timeline.mode).toEqual({ kind: 'live' });
  expect(timeline.items.map((entry) => entry.id)).toEqual(['end', 'arrived']);
  expect(timeline.resumingLive).toBe(false);
  core.emit({
    type: 'timeline_diff',
    subscription: 3,
    diffs: [{ PushBack: { value: item('next') } }],
  });
  expect(timeline.items.at(-1)?.id).toBe('next');
});

test('returning to live keeps the unread context on screen until the live snapshot arrives', async () => {
  const core = new FakeCore();
  const live = { subscription: 3, items: [item('end'), item('arrived')], aggregations: [] };
  const pending = Promise.withResolvers<typeof live>();
  vi.spyOn(core, 'subscribeTimeline')
    .mockResolvedValueOnce({ subscription: 1, items: [item('end')], aggregations: [] })
    .mockResolvedValueOnce({
      subscription: 2,
      items: [item('read'), item('anchor')],
      aggregations: [],
    })
    .mockReturnValueOnce(pending.promise);
  const timeline = new RoomTimeline(core as unknown as CoreClient);
  await timeline.start('!room:example.org', null, false, true);
  expect(timeline.items.map((entry) => entry.id)).toEqual(['read', 'anchor']);

  const handoff = timeline.resumeLive();
  await vi.waitFor(() => {
    expect(timeline.resumingLive).toBe(true);
  });

  expect(timeline.items.map((entry) => entry.id)).toEqual(['read', 'anchor']);
  expect(timeline.hasSnapshot).toBe(true);
  pending.resolve(live);
  await handoff;
  expect(timeline.items.map((entry) => entry.id)).toEqual(['end', 'arrived']);
});

test('concurrent returns to live share one subscription', async () => {
  const core = new FakeCore();
  const snapshot = { subscription: 3, items: [item('end')], aggregations: [] };
  const pending = Promise.withResolvers<typeof snapshot>();
  const subscribe = vi
    .spyOn(core, 'subscribeTimeline')
    .mockResolvedValueOnce({ subscription: 1, items: [item('end')], aggregations: [] })
    .mockResolvedValueOnce({ subscription: 2, items: [item('read')], aggregations: [] })
    .mockReturnValueOnce(pending.promise);
  const timeline = new RoomTimeline(core as unknown as CoreClient);
  await timeline.start('!room:example.org', null, false, true);

  const handoff = timeline.resumeLive();
  expect(timeline.resumeLive()).toBe(handoff);
  expect(timeline.resumingLive).toBe(true);
  pending.resolve(snapshot);
  await handoff;

  expect(subscribe).toHaveBeenCalledTimes(3);
  expect(timeline.resumingLive).toBe(false);
});

test('a failed return to live reports the error on the live timeline', async () => {
  const core = new FakeCore();
  vi.spyOn(core, 'subscribeTimeline')
    .mockResolvedValueOnce({ subscription: 1, items: [item('end')], aggregations: [] })
    .mockResolvedValueOnce({ subscription: 2, items: [item('read')], aggregations: [] })
    .mockRejectedValueOnce(new Error('offline'));
  const timeline = new RoomTimeline(core as unknown as CoreClient);
  await timeline.start('!room:example.org', null, false, true);

  await expect(timeline.resumeLive()).rejects.toThrow('Unable to load live messages');

  expect(timeline.mode).toEqual({ kind: 'live' });
  expect(timeline.error).toBe('load_failed');
  expect(timeline.items).toEqual([]);
  expect(timeline.resumingLive).toBe(false);
});

test('opening another room cancels a return to live', async () => {
  const core = new FakeCore();
  const unsubscribed = Promise.withResolvers<undefined>();
  vi.spyOn(core, 'unsubscribe')
    .mockResolvedValueOnce(undefined)
    .mockReturnValueOnce(unsubscribed.promise);
  vi.spyOn(core, 'subscribeTimeline')
    .mockResolvedValueOnce({ subscription: 1, items: [item('end')], aggregations: [] })
    .mockResolvedValueOnce({ subscription: 2, items: [item('anchor')], aggregations: [] })
    .mockResolvedValueOnce({ subscription: 3, items: [item('other-room')], aggregations: [] });
  const timeline = new RoomTimeline(core as unknown as CoreClient);
  await timeline.start('!room:example.org', null, false, true);
  const handoff = timeline.resumeLive();
  const cancelled = expect(handoff).rejects.toThrow('Room changed');
  const other = timeline.start('!other:example.org');
  unsubscribed.resolve(undefined);
  await other;
  await cancelled;
  expect(timeline.items.map((entry) => entry.id)).toEqual(['other-room']);
  expect(timeline.resumingLive).toBe(false);
});

test('a late live snapshot cannot replace the room opened during a return to live', async () => {
  const core = new FakeCore();
  const snapshot = { subscription: 3, items: [item('anchor')], aggregations: [] };
  const pending = Promise.withResolvers<typeof snapshot>();
  const subscribe = vi
    .spyOn(core, 'subscribeTimeline')
    .mockResolvedValueOnce({ subscription: 1, items: [item('end')], aggregations: [] })
    .mockResolvedValueOnce({ subscription: 2, items: [item('read')], aggregations: [] })
    .mockReturnValueOnce(pending.promise)
    .mockResolvedValueOnce({ subscription: 4, items: [item('other-room')], aggregations: [] });
  const timeline = new RoomTimeline(core as unknown as CoreClient);
  await timeline.start('!room:example.org', null, false, true);
  const handoff = timeline.resumeLive();
  const cancelled = expect(handoff).rejects.toThrow('Room changed');
  await vi.waitFor(() => {
    expect(subscribe).toHaveBeenCalledTimes(3);
  });
  await timeline.start('!other:example.org');
  pending.resolve(snapshot);
  await cancelled;
  expect(timeline.items.map((entry) => entry.id)).toEqual(['other-room']);
  expect(timeline.subscriptionId).toBe(4);
  expect(timeline.resumingLive).toBe(false);
});

test.each(['marker', 'event'] as const)(
  'keeps the cached live window when the read %s is loaded',
  async (boundary) => {
    const core = new FakeCore();
    const subscribe = vi.spyOn(core, 'subscribeTimeline').mockResolvedValue({
      subscription: 1,
      items: [
        boundary === 'marker'
          ? withRowFields({
              ...item('marker'),
              event_id: null,
              content: { kind: 'read_marker' },
            })
          : item('read'),
        item('first'),
      ],
      aggregations: [],
    });
    const marker = vi.spyOn(core, 'readMarker');
    const timeline = new RoomTimeline(core as unknown as CoreClient);
    await timeline.start('!room:example.org', null, false, true);
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(timeline.mode).toEqual({ kind: 'live' });
    expect(core.paginateCalls).toBe(0);
    if (boundary === 'marker') expect(marker).not.toHaveBeenCalled();
  }
);

test.each(['missing', 'failure'] as const)(
  'opens live when the unread marker is %s',
  async (result) => {
    const core = new FakeCore();
    const marker = vi.spyOn(core, 'readMarker');
    if (result === 'missing') marker.mockResolvedValue(null);
    else marker.mockRejectedValue(new Error('account data unavailable'));
    const timeline = new RoomTimeline(core as unknown as CoreClient);
    await timeline.start('!room:example.org', null, false, true);
    expect(core.subscribeCalls).toEqual([{ roomId: '!room:example.org', focus: { kind: 'live' } }]);
    expect(timeline.error).toBeNull();
    expect(timeline.hasSnapshot).toBe(true);
  }
);

test('falls back to live when the unread marker context cannot be loaded', async () => {
  const core = new FakeCore();
  const original = core.subscribeTimeline.bind(core);
  const subscribe = vi
    .spyOn(core, 'subscribeTimeline')
    .mockImplementation((roomId, focus) =>
      focus.kind === 'event' ? Promise.reject(new Error('not found')) : original(roomId, focus)
    );
  const timeline = new RoomTimeline(core as unknown as CoreClient);
  await timeline.start('!room:example.org', null, false, true);
  expect(subscribe.mock.calls.map(([, focus]) => focus)).toEqual([
    { kind: 'live' },
    { kind: 'event', event_id: '$read' },
    { kind: 'live' },
  ]);
  expect(timeline.mode).toEqual({ kind: 'live' });
  expect(timeline.error).toBeNull();
  expect(timeline.hasSnapshot).toBe(true);
});

test('a late unread marker lookup cannot reopen the room after switching away', async () => {
  const core = new FakeCore();
  const marker = Promise.withResolvers<string>();
  vi.spyOn(core, 'readMarker').mockReturnValueOnce(marker.promise);
  const timeline = new RoomTimeline(core as unknown as CoreClient);
  const opening = timeline.start('!room:example.org', null, false, true);
  await Promise.resolve();
  await timeline.start('!other:example.org');
  marker.resolve('$old-read');
  await opening;
  expect(core.subscribeCalls).toEqual([
    { roomId: '!room:example.org', focus: { kind: 'live' } },
    { roomId: '!other:example.org', focus: { kind: 'live' } },
  ]);
  expect(timeline.mode).toEqual({ kind: 'live' });
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

test('a forward page is done when its command replies and its messages land after', async () => {
  const core = new FakeCore();
  const timeline = new RoomTimeline(core as unknown as CoreClient);
  await timeline.start('!room:example.org', '$initial');
  const reply = deferred<{ direction: 'forward' | 'backward'; reached_end: boolean }>();
  const paginate = vi.spyOn(core, 'paginate').mockReturnValue(reply.promise);
  const page = timeline.paginateForward(25);
  expect(timeline.forwardPagination).toBe('loading');
  await timeline.paginateForward(25);
  expect(paginate).toHaveBeenCalledTimes(1);

  reply.resolve({ direction: 'forward', reached_end: false });
  await page;
  expect(timeline.forwardPagination).toBe('idle');
  core.emit({
    type: 'timeline_diff',
    subscription: 1,
    diffs: [{ PushBack: { value: item('newer') } }],
  });
  expect(timeline.items.at(-1)?.id).toBe('newer');
  await timeline.stop();
});

test('the last forward page reports the latest on its reply', async () => {
  const core = new FakeCore();
  const timeline = new RoomTimeline(core as unknown as CoreClient);
  await timeline.start('!room:example.org', '$initial');
  vi.spyOn(core, 'paginate').mockResolvedValue({ direction: 'forward', reached_end: true });
  await timeline.paginateForward(25);
  expect(timeline.forwardPagination).toBe('end');
  await timeline.stop();
});

test('an empty forward page is retryable at once', async () => {
  const core = new FakeCore();
  const timeline = new RoomTimeline(core as unknown as CoreClient);
  await timeline.start('!room:example.org', '$initial');
  vi.spyOn(core, 'paginate').mockResolvedValue({ direction: 'forward', reached_end: false });
  await timeline.paginateForward(25);
  expect(timeline.forwardPagination).toBe('idle');
  await timeline.stop();
});

test('a failed forward page rejects and remains manually retryable', async () => {
  const core = new FakeCore();
  const timeline = new RoomTimeline(core as unknown as CoreClient);
  await timeline.start('!room:example.org', '$target');
  const paginate = vi.spyOn(core, 'paginate').mockRejectedValueOnce(new Error('offline'));
  await expect(timeline.paginateForward(25)).rejects.toThrow('offline');
  expect(timeline.error).toBe('load_failed');
  expect(timeline.forwardPagination).toBe('idle');
  await expect(timeline.paginateForward(25)).resolves.toBe(true);
  expect(timeline.error).toBeNull();
  expect(paginate).toHaveBeenCalledTimes(2);
  await timeline.stop();
});

test('does not resubscribe when started again for the same room', async () => {
  const core = new FakeCore();
  const timeline = new RoomTimeline(core as unknown as CoreClient);

  await timeline.start('!room:example.org');
  await timeline.start('!room:example.org');

  expect(core.subscribeCalls).toEqual([{ roomId: '!room:example.org', focus: { kind: 'live' } }]);
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

class RetryPaginationCore extends FakeCore {
  failNextPagination = true;

  override paginate(subscription: number, direction: 'backward' | 'forward') {
    if (this.failNextPagination) {
      this.failNextPagination = false;
      return Promise.reject(new Error('pagination failed'));
    }
    return super.paginate(subscription, direction);
  }
}

test('clears a failed backward pagination error after a successful retry', async () => {
  const core = new RetryPaginationCore();
  const timeline = new RoomTimeline(core as unknown as CoreClient);
  await timeline.start('!room:example.org');

  await expect(timeline.paginateBackward(25)).rejects.toThrow('pagination failed');
  expect(timeline.error).toBe('load_failed');
  expect(timeline.backwardPagination).toBe('idle');

  await timeline.paginateBackward(25);
  expect(timeline.error).toBe(null);
});

test('a thread starts at its live end and never paginates forwards', async () => {
  const core = new FakeCore();
  const timeline = new RoomTimeline(core as unknown as CoreClient);
  await timeline.startThread('!room:example.org', '$root');
  expect(timeline.forwardPagination).toBe('end');

  await timeline.paginateForward(25);

  expect(core.paginateSubscriptions).toEqual([]);
  expect(timeline.forwardPagination).toBe('end');
});

test('never paginates a live timeline forwards', async () => {
  const core = new FakeCore();
  const timeline = new RoomTimeline(core as unknown as CoreClient);
  await timeline.start('!room:example.org');

  await expect(timeline.paginateForward(25)).resolves.toBe(true);

  expect(core.paginateSubscriptions).toEqual([]);
});

test('clears a failed forward pagination error after a successful retry', async () => {
  const core = new RetryPaginationCore();
  const timeline = new RoomTimeline(core as unknown as CoreClient);
  await timeline.start('!room:example.org', '$target');

  await expect(timeline.paginateForward(25)).rejects.toThrow('pagination failed');
  expect(timeline.error).toBe('load_failed');

  await timeline.paginateForward(25);
  expect(timeline.error).toBe(null);
});

class DelayedDiffCore extends FakeCore {
  override subscribeTimeline(roomId: string, focus: TimelineFocusView) {
    this.subscribeCalls.push({ roomId, focus });
    this.emit({
      type: 'timeline_pagination',
      subscription: 1,
      loading: false,
      reached_start: false,
    });
    return Promise.resolve({ subscription: 1, items: [item('latest')], aggregations: [] });
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
      { Insert: { index: 0, value: item('history-1') } },
      { Insert: { index: 1, value: item('history-2') } },
    ],
  });

  expect(timeline.items.map((entry) => entry.id)).toEqual(['history-1', 'history-2', 'latest']);
});

test('a live page is done when its command replies and its diff lands after', async () => {
  const core = new FakeCore();
  vi.spyOn(core, 'paginate').mockResolvedValue({ direction: 'backward', reached_end: false });
  const timeline = new RoomTimeline(core as unknown as CoreClient);
  await timeline.start('!room:example.org');

  await timeline.paginateBackward(25);
  expect(timeline.backwardPagination).toBe('idle');

  core.emit({
    type: 'timeline_diff',
    subscription: 1,
    diffs: [{ PushFront: { value: item('history') } }],
  });
  expect(timeline.items.map((entry) => entry.id)).toEqual(['history', 'initial']);
});

test('a live page that reached the start ends on its reply', async () => {
  const core = new FakeCore();
  vi.spyOn(core, 'paginate').mockResolvedValue({ direction: 'backward', reached_end: true });
  const timeline = new RoomTimeline(core as unknown as CoreClient);
  await timeline.start('!room:example.org');

  await expect(timeline.paginateBackward(25)).resolves.toBe(true);

  expect(timeline.backwardPagination).toBe('end');
});

test('the SDK status drives a live timeline between commands', async () => {
  const core = new FakeCore();
  const timeline = new RoomTimeline(core as unknown as CoreClient);
  await timeline.start('!room:example.org');

  core.emit({ type: 'timeline_pagination', subscription: 1, loading: true, reached_start: false });
  expect(timeline.backwardPagination).toBe('loading');
  core.emit({ type: 'timeline_pagination', subscription: 1, loading: false, reached_start: true });
  expect(timeline.backwardPagination).toBe('end');
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((next, fail) => {
    resolve = next;
    reject = fail;
  });
  return { promise, resolve, reject };
}

class PendingPaginationCore extends FakeCore {
  readonly pendingPagination = deferred<{ reached_end: boolean }>();

  override paginate(subscription: number, direction: 'backward' | 'forward') {
    this.paginateCalls += 1;
    this.paginateSubscriptions.push(subscription);
    return this.pendingPagination.promise.then((response) => ({ direction, ...response }));
  }
}

test('a live page applies diffs that land before its reply', async () => {
  const core = new PendingPaginationCore();
  const timeline = new RoomTimeline(core as unknown as CoreClient);
  await timeline.start('!room:example.org');

  const pagination = timeline.paginateBackward(25);
  core.emit({
    type: 'timeline_diff',
    subscription: 1,
    diffs: [{ PushFront: { value: item('history') } }],
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
    ReturnType<
      typeof deferred<{ subscription: number; items: TimelineItemView[]; aggregations: [] }>
    >
  >();
  readonly unsubscribed: number[] = [];
  readonly paginateSubscriptions: number[] = [];

  subscribeEvents(listener: (event: CoreEvent) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeTimeline(roomId: string) {
    const response = deferred<{
      subscription: number;
      items: TimelineItemView[];
      aggregations: [];
    }>();
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

  get rpc() {
    return {
      timeline: {
        subscribe: (params: { room_id: string }) => this.subscribeTimeline(params.room_id),
        paginate: (params: { subscription: number; direction: 'backward' | 'forward' }) =>
          this.paginate(params.subscription, params.direction),
        unsubscribe: (params: { subscription: number }) => this.unsubscribe(params.subscription),
      },
    };
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
  secondResponse.resolve({ subscription: 2, items: [item('second')], aggregations: [] });
  await secondStart;
  const firstResponse = core.responses.get('!first:example.org');
  if (!firstResponse) throw new Error('first subscription was not created');
  firstResponse.resolve({ subscription: 1, items: [item('first')], aggregations: [] });
  await firstStart;

  expect(timeline.items.map((entry) => entry.id)).toEqual(['second']);
  expect(core.unsubscribed).toEqual([1]);
});

test('a second start of a failing subscription resolves and reports the error', async () => {
  const core = new FakeCore();
  let fail: (error: Error) => void = () => {};
  core.subscribeTimeline = () =>
    new Promise((_, reject) => {
      fail = reject;
    });
  const timeline = new RoomTimeline(core as unknown as CoreClient);

  const first = timeline.start('!room:example.org');
  await Promise.resolve();
  const second = timeline.start('!room:example.org');
  fail(new Error('failed'));

  await expect(first).resolves.toBeUndefined();
  await expect(second).resolves.toBeUndefined();
  expect(timeline.error).toBe('load_failed');
});

test('a stale failed start cannot stop the active room subscription', async () => {
  const core = new SwitchingCore();
  const timeline = new RoomTimeline(core as unknown as CoreClient);

  const firstStart = timeline.start('!first:example.org');
  void timeline.stop();
  const secondStart = timeline.start('!second:example.org');
  const secondResponse = core.responses.get('!second:example.org');
  if (!secondResponse) throw new Error('second subscription was not created');
  secondResponse.resolve({ subscription: 2, items: [item('second')], aggregations: [] });
  await secondStart;

  const firstResponse = core.responses.get('!first:example.org');
  if (!firstResponse) throw new Error('first subscription was not created');
  firstResponse.reject(new Error('stale failure'));
  await firstStart;
  core.emit({
    type: 'timeline_diff',
    subscription: 2,
    diffs: [{ PushBack: { value: item('live') } }],
  });

  expect(timeline.items.map((entry) => entry.id)).toEqual(['second', 'live']);
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
  expect(core.subscribeCalls).toEqual([{ roomId: '!first:example.org', focus: { kind: 'live' } }]);

  unsubscribe.resolve(undefined);
  await next;
  expect(core.subscribeCalls).toEqual([
    { roomId: '!first:example.org', focus: { kind: 'live' } },
    { roomId: '!second:example.org', focus: { kind: 'live' } },
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
  secondResponse.resolve({ subscription: 2, items: [item('second')], aggregations: [] });
  await secondStart;

  const firstResponse = core.responses.get('!first:example.org');
  if (!firstResponse) throw new Error('first subscription was not created');
  firstResponse.resolve({ subscription: 1, items: [item('first')], aggregations: [] });
  await firstStart;

  expect(core.paginateSubscriptions).toEqual([]);
});

test('a diff that lands before the snapshot reply keeps later indices aligned', async () => {
  const core = new SwitchingCore();
  const timeline = new RoomTimeline(core as unknown as CoreClient);

  const start = timeline.start('!room:example.org');
  core.emit({
    type: 'timeline_diff',
    subscription: 1,
    diffs: [{ Insert: { index: 0, value: item('divider') } }],
  });
  const response = core.responses.get('!room:example.org');
  if (!response) throw new Error('subscription was not created');
  response.resolve({ subscription: 1, items: [item('a')], aggregations: [] });
  await start;

  core.emit({
    type: 'timeline_diff',
    subscription: 1,
    diffs: [{ PushBack: { value: item('echo') } }],
  });
  core.emit({
    type: 'timeline_diff',
    subscription: 1,
    diffs: [{ Remove: { index: 2 } }, { Insert: { index: 2, value: item('remote') } }],
  });

  expect(timeline.items.map((entry) => entry.id)).toEqual(['divider', 'a', 'remote']);
});

test('ignores events that precede the subscription snapshot', async () => {
  const core = new SwitchingCore();
  const timeline = new RoomTimeline(core as unknown as CoreClient);

  const start = timeline.start('!room:example.org', '$event:example.org');
  core.emit({ type: 'timeline_pagination', subscription: 1, loading: true, reached_start: false });
  core.emit({ type: 'timeline_pagination', subscription: 2, loading: false, reached_start: true });

  const response = core.responses.get('!room:example.org');
  if (!response) throw new Error('subscription was not created');
  response.resolve({ subscription: 1, items: [item('initial')], aggregations: [] });
  await start;

  expect(timeline.backwardPagination).toBe('idle');
});

test('a cleared timeline drops the start it had reached', async () => {
  const core = new FakeCore();
  const timeline = new RoomTimeline(core as unknown as CoreClient);

  await timeline.start('!room:example.org');
  await timeline.paginateBackward(25);
  expect(timeline.backwardPagination).toBe('end');

  core.emit({ type: 'timeline_diff', subscription: 1, diffs: [{ Clear: {} }] });

  expect(timeline.items).toEqual([]);
  expect(timeline.backwardPagination).toBe('idle');
});

test('a clear mid-pagination discards the answer that pagination brings back', async () => {
  type PaginateResponse = { direction: 'backward'; reached_end: boolean };
  const pending: { settle: (response: PaginateResponse) => void } = { settle: () => {} };
  const core = new FakeCore();
  core.paginate = () =>
    new Promise((resolve) => {
      pending.settle = resolve;
    });
  const timeline = new RoomTimeline(core as unknown as CoreClient);

  await timeline.start('!room:example.org');
  const pagination = timeline.paginateBackward(25);
  expect(timeline.backwardPagination).toBe('loading');

  core.emit({ type: 'timeline_diff', subscription: 1, diffs: [{ Clear: {} }] });
  expect(timeline.backwardPagination).toBe('idle');

  pending.settle({ direction: 'backward', reached_end: true });
  await pagination;

  expect(timeline.backwardPagination).toBe('idle');
});

test('a clear mid forward page discards its answer and leaves forward paging retryable', async () => {
  type PaginateResponse = { direction: 'forward'; reached_end: boolean };
  const pending: { settle: (response: PaginateResponse) => void } = { settle: () => {} };
  const core = new FakeCore();
  core.paginate = () =>
    new Promise((resolve) => {
      pending.settle = resolve;
    });
  const timeline = new RoomTimeline(core as unknown as CoreClient);

  await timeline.start('!room:example.org', '$event:example.org');
  const pagination = timeline.paginateForward(25);
  expect(timeline.forwardPagination).toBe('loading');

  core.emit({ type: 'timeline_diff', subscription: 1, diffs: [{ Clear: {} }] });
  expect(timeline.forwardPagination).toBe('idle');

  pending.settle({ direction: 'forward', reached_end: true });
  await pagination;

  expect(timeline.forwardPagination).toBe('idle');
});

test('a thread subscribes to its root and reports the mode', async () => {
  const core = new FakeCore();
  const timeline = new RoomTimeline(core as unknown as CoreClient);

  await timeline.startThread('!room:example.org', '$root');

  expect(core.subscribeCalls).toEqual([
    { roomId: '!room:example.org', focus: { kind: 'thread', root_event_id: '$root' } },
  ]);
  expect(timeline.mode).toEqual({ kind: 'thread', rootEventId: '$root' });
});

test('reopening the same thread does not resubscribe', async () => {
  const core = new FakeCore();
  const timeline = new RoomTimeline(core as unknown as CoreClient);

  await timeline.startThread('!room:example.org', '$root');
  await timeline.startThread('!room:example.org', '$root');

  expect(core.subscribeCalls).toHaveLength(1);
});

test('a different thread in the same room resubscribes', async () => {
  const core = new FakeCore();
  const timeline = new RoomTimeline(core as unknown as CoreClient);

  await timeline.startThread('!room:example.org', '$one');
  await timeline.startThread('!room:example.org', '$two');

  expect(core.subscribeCalls.map((call) => call.focus)).toEqual([
    { kind: 'thread', root_event_id: '$one' },
    { kind: 'thread', root_event_id: '$two' },
  ]);
});
