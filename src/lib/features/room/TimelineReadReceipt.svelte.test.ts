import { mount, tick, unmount } from 'svelte';
import { expect, test, vi } from 'vitest';

import type { TimelineItemView } from '#src/generated/TimelineItemView';
import type { CoreClient } from '#lib/core/client.svelte.js';
import { RoomTimeline } from '#lib/rooms/timeline.svelte.js';

import TimelineReadReceipt from './TimelineReadReceipt.svelte';

function item(): TimelineItemView {
  return {
    id: 'latest',
    event_id: '$latest',
    transaction_id: null,
    send_state: null,
    sender: '@alice:example.org',
    sender_name: 'Alice',
    sender_avatar: null,
    timestamp: 0,
    content: {
      kind: 'message',
      body: 'latest',
      html: 'latest',
      emote: false,
      notice: false,
      edited: false,
    },
    in_reply_to: null,
    thread_root: null,
    thread_summary: null,
    reactions: [],
    is_own: false,
    read_by: [],
    per_message_profile: null,
    mention: 'none',
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

test('does not duplicate a read receipt while the first request is pending', async () => {
  vi.useFakeTimers();
  const timeline = new RoomTimeline({} as CoreClient);
  timeline.items = [item()];
  const pending = deferred<undefined>();
  const read = vi.fn(() => pending.promise);
  const instance = mount(TimelineReadReceipt, {
    target: document.body,
    props: {
      timeline,
      visibleEventId: '$latest',
      onRead: read,
    },
  });

  await tick();
  await vi.advanceTimersByTimeAsync(500);
  timeline.items = [...timeline.items];
  await tick();
  await vi.advanceTimersByTimeAsync(500);

  expect(read).toHaveBeenCalledTimes(1);
  pending.resolve(undefined);
  await unmount(instance);
  vi.useRealTimers();
});

function itemWithId(id: string): TimelineItemView {
  return { ...item(), id, event_id: `$${id}` };
}

test('a fast scroll across many rows sends one receipt for the newest', async () => {
  vi.useFakeTimers();
  const timeline = new RoomTimeline({} as CoreClient);
  timeline.items = [itemWithId('a'), itemWithId('b'), itemWithId('c')];
  const read = vi.fn(() => Promise.resolve(undefined));
  const props = $state({ timeline, visibleEventId: '$a', onRead: read });
  const instance = mount(TimelineReadReceipt, { target: document.body, props });

  await tick();
  props.visibleEventId = '$b';
  await tick();
  props.visibleEventId = '$c';
  await tick();

  expect(read).not.toHaveBeenCalled();

  await vi.advanceTimersByTimeAsync(500);

  expect(read).toHaveBeenCalledTimes(1);
  expect(read).toHaveBeenCalledWith('$c');

  await unmount(instance);
  vi.useRealTimers();
});

test('waits for the current receipt before sending the newer one', async () => {
  vi.useFakeTimers();
  const timeline = new RoomTimeline({} as CoreClient);
  timeline.items = [itemWithId('a'), itemWithId('b')];
  const first = deferred<undefined>();
  const read = vi
    .fn()
    .mockImplementationOnce(() => first.promise)
    .mockResolvedValue(undefined);
  const props = $state({ timeline, visibleEventId: '$a', onRead: read });
  const instance = mount(TimelineReadReceipt, { target: document.body, props });

  await tick();
  await vi.advanceTimersByTimeAsync(500);
  props.visibleEventId = '$b';
  await tick();
  await vi.advanceTimersByTimeAsync(500);

  expect(read).toHaveBeenCalledTimes(1);
  first.resolve(undefined);
  await tick();

  expect(read).toHaveBeenNthCalledWith(2, '$b');
  await unmount(instance);
  vi.useRealTimers();
});

test('hiding the document sends the pending receipt rather than losing it', async () => {
  vi.useFakeTimers();
  const timeline = new RoomTimeline({} as CoreClient);
  timeline.items = [itemWithId('a')];
  const read = vi.fn(() => Promise.resolve(undefined));
  const instance = mount(TimelineReadReceipt, {
    target: document.body,
    props: { timeline, visibleEventId: '$a', onRead: read },
  });

  await tick();
  expect(read).not.toHaveBeenCalled();

  Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
  await tick();

  expect(read).toHaveBeenCalledWith('$a');

  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  await unmount(instance);
  vi.useRealTimers();
});
