// @vitest-environment happy-dom

import { asWireRows, asWireItems } from '#lib/test-support/timeline-wire.js';

import { type ResolvedItem } from '#lib/rooms/timeline-item.js';
import { flushSync } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

import type { TimelineDocView } from '#src/generated/protocol';

import { FakeRuntime, replied } from '#lib/test-support/fake-runtime.js';
import { rowsOf } from '#lib/test-support/static-timeline.svelte.js';

import { provideRuntime } from '#lib/runtime/app.js';
import { eventBefore } from '#lib/model/model.js';
import type { Client } from '#lib/runtime/client.js';

import { activeRoomTimeline, NO_UNREAD, RoomTimeline } from './timeline.svelte.js';

afterEach(() => {
  vi.restoreAllMocks();
});

function item(id: string): ResolvedItem {
  return {
    id,
    row: 'message',
    event_id: `$${id}`,
    transaction_id: null,
    sender: '@alice:example.org',
    timestamp: 1_000,
    content: { kind: 'message', body: id, html: id, emote: false, notice: false, edited: false },
  } as unknown as ResolvedItem;
}

function view(items: ResolvedItem[], status: Partial<TimelineDocView['status']> = {}) {
  return {
    total: items.length,
    items: asWireRows(rowsOf(items)),
    status: {
      mode: { kind: 'live' },
      loading: false,
      resuming_live: false,
      has_snapshot: true,
      forward_pagination: 'idle',
      backward_pagination: 'idle',
      error: null,
      subscription: 7,
      can_resume_live: false,
      reaches_latest: true,
      latest_event_id: items.at(-1)?.event_id ?? null,
      item_count: items.length,
      unread: NO_UNREAD,
      ...status,
    },
    aggregations: { total: 0, items: [] },
  } satisfies TimelineDocView;
}

function fixture(
  initial = view([item('a'), item('b')]),
  reply: (action: unknown) => unknown = () => null
) {
  const runtime = new FakeRuntime({ timeline: initial }, undefined, (_target, action) =>
    replied(reply(action))
  );
  return { runtime, timeline: new RoomTimeline(() => runtime.client()) };
}

function types(runtime: FakeRuntime): string[] {
  return runtime.dispatched.map(({ action }) => (action as { type: string }).type);
}

test('opening a room subscribes to its key, configures it and asks it to open', async () => {
  const { runtime, timeline } = fixture();
  await timeline.start('!room:x', null, true, false, null, true);

  expect(types(runtime)).toContain('configure');
  const [{ target, action }] = runtime.requested;
  expect(target.slice).toBe('timeline');
  expect(target.key).toMatchObject({ room_id: '!room:x' });
  expect(action).toEqual({
    type: 'open',
    target: { kind: 'live' },
    hidden_events: true,
    unread: false,
    has_unread: true,
    landing: null,
  });
  expect(timeline.rows.map((row) => row.item.id)).toEqual(['a', 'b']);
  expect(timeline.items.map((entry) => entry.id)).toEqual(['a', 'b']);
  expect(timeline.hasSnapshot).toBe(true);
  expect(timeline.subscriptionId).toBe(7);
  expect(timeline.latestEventId).toBe('$b');
  expect(types(runtime).filter((type) => type === 'configure')).toHaveLength(1);
});

test('a superseded open cannot dispatch to the next room', async () => {
  const runtime = new FakeRuntime({ timeline: view([item('a')]) });
  let connectFirst!: (client: Client) => void;
  let first = true;
  const timeline = new RoomTimeline(() =>
    first
      ? new Promise<Client>((resolve) => {
          first = false;
          connectFirst = resolve;
        })
      : runtime.client()
  );

  const opening = timeline.start('!one:x');
  await timeline.start('!two:x');
  connectFirst(await runtime.client());
  await opening;

  expect(runtime.requested.map(({ target }) => target.key)).toEqual([
    expect.objectContaining({ room_id: '!two:x' }),
  ]);
});

test('a superseded open in the same room cannot dispatch its stale action', async () => {
  const { runtime, timeline } = fixture();
  const first = timeline.start('!room:x');
  const second = timeline.start('!room:x', '$focused');
  await Promise.all([first, second]);

  expect(runtime.requested.map(({ action }) => action)).toEqual([
    expect.objectContaining({ target: { kind: 'focused', event_id: '$focused' } }),
  ]);
});

test('a permalink can find a loaded event above a windowed row', async () => {
  const runtime = new FakeRuntime({ timeline: view([item('older'), item('held')]) });
  const timeline = new RoomTimeline(() => runtime.client(), true);
  await timeline.start('!room:x');
  runtime.set('timeline', {
    ...view([item('held')]),
    events: { total: 2, items: asWireItems([item('older'), item('held')]) },
  });

  expect(timeline.rows.map((row) => row.item.id)).toEqual(['held']);
  expect(timeline.items.map((entry) => entry.id)).toEqual(['older', 'held']);
});

test('marking the first held row unread uses the loaded event above it', async () => {
  const above = item('above');
  const held = item('held');
  const snapshot: TimelineDocView = {
    ...view([held]),
    total: 2,
    events: { total: 2, items: asWireItems([above, held]) },
  };
  const runtime = new FakeRuntime({ timeline: snapshot });
  const timeline = new RoomTimeline(() => runtime.client(), true);
  await timeline.start('!room:x');

  expect(timeline.first).toBe(1);
  expect(timeline.rows.map((row) => row.item.id)).toEqual(['held']);
  expect(timeline.items.map((entry) => entry.id)).toEqual(['above', 'held']);
  expect(
    eventBefore(
      timeline.items.map((entry) => entry.event_id),
      '$held'
    )
  ).toBe('$above');
  timeline.detach();
});

test('the status reads as the modes and pagination states the UI knows', async () => {
  const { runtime, timeline } = fixture();
  await timeline.startUnread('!room:x', '$a');
  runtime.set(
    'timeline',
    view([item('a')], {
      mode: { kind: 'unread', event_id: '$a' },
      forward_pagination: 'loading',
      backward_pagination: 'end',
      can_resume_live: true,
      reaches_latest: false,
    })
  );

  expect(timeline.mode).toEqual({ kind: 'unread', event_id: '$a' });
  expect(timeline.forwardPagination).toBe('loading');
  expect(timeline.backwardPagination).toBe('end');
  expect(timeline.canResumeLive).toBe(true);
  expect(timeline.reachesLatest).toBe(false);
});

test('an unwindowed timeline derives every grouped item from its rows', async () => {
  const first = item('first');
  const last = item('last');
  const snapshot = view([last]);
  snapshot.items[0].group = asWireItems([first, last]).map((item) => ({
    reply_target: true,
    item,
  }));
  const { timeline } = fixture(snapshot);
  await timeline.startThread('!room:x', '$root');

  expect(timeline.rows).toHaveLength(1);
  expect(timeline.items.map((entry) => entry.id)).toEqual(['first', 'last']);
  timeline.detach();
});

test('a thread opens by its root', async () => {
  const { runtime, timeline } = fixture();
  await timeline.startThread('!room:x', '$root');
  expect(runtime.requested[0].action).toMatchObject({
    type: 'open',
    target: { kind: 'thread', root_event_id: '$root' },
  });
});

test('pagination answers whether the end was reached', async () => {
  const { runtime, timeline } = fixture(undefined, (action) =>
    (action as { type: string }).type === 'paginate' ? { reached_end: true } : null
  );
  await timeline.start('!room:x');

  await expect(timeline.paginateBackward(30)).resolves.toBe(true);
  expect(runtime.requested.at(-1)?.action).toEqual({
    type: 'paginate',
    direction: 'backward',
    count: 30,
  });
});

test('the list tells the timeline how it reads it, and the filters follow the preferences', async () => {
  const { runtime, timeline } = fixture();
  timeline.show({ readOnly: true, threadRoot: '$root' });
  await timeline.start('!room:x');
  await vi.waitFor(() => {
    const configured = runtime.dispatched.filter(
      ({ action }) => (action as { type: string }).type === 'configure'
    );
    expect(configured.at(-1)?.action).toMatchObject({
      read_only: true,
      thread_root: '$root',
      reply_style: 'connected',
    });
  });
});

test('another room is another subscription, and the first one is let go', async () => {
  const { runtime, timeline } = fixture();
  await timeline.start('!one:x');
  await timeline.start('!two:x');

  expect(
    runtime.requested.map(({ target }) => (target.key as { room_id: string }).room_id)
  ).toEqual(['!one:x', '!two:x']);
  expect(runtime.unsubscribed.length).toBe(1);
});

test('detaching releases the view and leaves the timeline to the grace period', async () => {
  const { runtime, timeline } = fixture();
  await timeline.start('!room:x');
  timeline.detach();

  expect(types(runtime)).toContain('release');
  expect(types(runtime)).not.toContain('stop');
  expect(timeline.rows).toEqual([]);
  await vi.waitFor(() => {
    expect(runtime.unsubscribed.length).toBe(1);
  });
});

test('stopping empties the timeline', async () => {
  const { runtime, timeline } = fixture();
  await timeline.start('!room:x');
  await timeline.stop();

  expect(types(runtime)).toContain('stop');
  expect(timeline.hasSnapshot).toBe(false);
});

const WAITING = { ...NO_UNREAD, active: true };

test('the unread tracker is driven by actions', async () => {
  const { runtime, timeline } = fixture(view([item('a')], { unread: WAITING }));
  await timeline.start('!room:x');
  await timeline.initializeUnread(true);
  timeline.observeUnread('$a');
  timeline.viewing(true, '$a');
  timeline.read('$a');
  timeline.roomUnread(false);
  timeline.clearUnread();

  expect(runtime.requested.at(-1)?.action).toEqual({ type: 'initialize_unread', has_unread: true });
  expect(types(runtime).slice(-5)).toEqual([
    'observe_unread',
    'viewing',
    'read',
    'room_unread',
    'clear_unread',
  ]);
});

test('another room shows its own rows to a reader that is already watching', async () => {
  const { runtime, timeline } = fixture(view([item('a')]));
  let seen: string[] = [];
  const stop = $effect.root(() => {
    $effect(() => {
      seen = timeline.rows.map((row) => row.item.id);
    });
  });
  await timeline.start('!one:x');
  flushSync();
  expect(seen).toEqual(['a']);

  runtime.set('timeline', view([item('b')]));
  await timeline.start('!two:x');
  flushSync();
  expect(seen).toEqual(['b']);

  timeline.detach();
  runtime.set('timeline', view([item('c')]));
  await timeline.start('!one:x');
  flushSync();
  expect(seen).toEqual(['c']);
  stop();
});

test('the room timeline outlives the view that first asked for it', async () => {
  const runtime = new FakeRuntime({ timeline: view([item('a')]) });
  provideRuntime(runtime.client());
  let shared!: ReturnType<typeof activeRoomTimeline>;
  $effect.root(() => {
    shared = activeRoomTimeline();
  })();

  const owner = Symbol('room view');
  let seen: string[] = [];
  const stop = $effect.root(() => {
    $effect(() => {
      seen = shared.timeline.rows.map((row) => row.item.id);
    });
  });
  await shared.start(owner, '!one:x', null);
  flushSync();
  expect(seen).toEqual(['a']);

  shared.stop(owner);
  runtime.set('timeline', view([item('b')]));
  await shared.start(Symbol('next room view'), '!two:x', null);
  flushSync();
  expect(seen).toEqual(['b']);

  runtime.set('timeline', view([item('a')]));
  await shared.start(Symbol('back'), '!one:x', null);
  flushSync();
  expect(seen).toEqual(['a']);
  stop();
});

test('the room timeline waits for its rows to be counted, then holds the newest ones', async () => {
  const rows = Array.from({ length: 200 }, (_, index) => item(`m${String(index)}`));
  const runtime = new FakeRuntime({ timeline: view([]) });
  const timeline = new RoomTimeline(() => runtime.client(), true);
  await timeline.start('!one:x');
  expect(runtime.windows[0]).toMatchObject({ end: 4_294_967_295 });

  runtime.set('timeline', view(rows));
  await vi.waitFor(() => {
    expect(runtime.windows).toHaveLength(2);
  });
  expect(runtime.windows[1]).toEqual({ start: 120, end: 4_294_967_295 });
});
