import { render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const native = vi.hoisted(() => ({
  onFocus: null as ((focused: boolean) => void) | null,
}));

vi.mock('#lib/platform/window-decorations.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('#lib/platform/window-decorations.js')>()),
  watchWindowFocus: (onFocus: (focused: boolean) => void) => {
    native.onFocus = onFocus;
    return Promise.resolve(() => {});
  },
}));

import type { TimelineItemView } from '#src/generated/protocol';
import type { CoreClient } from '#lib/core/client.svelte.js';
import { RoomTimeline } from '#lib/rooms/timeline.svelte.js';

import TimelineReadReceipt from './TimelineReadReceipt.svelte';

beforeEach(() => {
  native.onFocus = null;
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

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
    read_timestamps: {},
    per_message_profile: null,
    bundled_link_previews: [],
    link_previews_removed: null,
    mention: 'none',
    forwarded: null,
    forum_title: null,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

test.each(['thread', 'focused'] as const)('%s receipt scope is respected', async (kind) => {
  vi.useFakeTimers();
  const timeline = new RoomTimeline({} as CoreClient);
  timeline.mode = kind === 'thread' ? { kind, rootEventId: '$root' } : { kind, eventId: '$latest' };
  timeline.items = [item()];
  const read = vi.fn().mockResolvedValue(undefined);
  const instance = render(TimelineReadReceipt, {
    props: { timeline, visibleEventId: '$latest', onRead: read },
  });
  await tick();
  await vi.advanceTimersByTimeAsync(500);
  expect(read).toHaveBeenCalledTimes(kind === 'thread' ? 1 : 0);
  instance.unmount();
  vi.useRealTimers();
});

test('does not duplicate a read receipt while the first request is pending', async () => {
  vi.useFakeTimers();
  const timeline = new RoomTimeline({} as CoreClient);
  timeline.items = [item()];
  const pending = deferred<undefined>();
  const read = vi.fn(() => pending.promise);
  const instance = render(TimelineReadReceipt, {
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
  instance.unmount();
  vi.useRealTimers();
});

test('a queued receipt is discarded when switching to focused history', async () => {
  vi.useFakeTimers();
  const timeline = new RoomTimeline({} as CoreClient);
  timeline.items = [item()];
  const read = vi.fn().mockResolvedValue(undefined);
  const instance = render(TimelineReadReceipt, {
    props: { timeline, visibleEventId: '$latest', onRead: read },
  });
  await tick();
  timeline.mode = { kind: 'focused', eventId: '$latest' };
  await tick();
  await vi.advanceTimersByTimeAsync(500);
  expect(read).not.toHaveBeenCalled();
  instance.unmount();
  vi.useRealTimers();
});

test('a focused timeline read to the live end sends a receipt', async () => {
  vi.useFakeTimers();
  const timeline = new RoomTimeline({} as CoreClient);
  timeline.mode = { kind: 'focused', eventId: '$latest' };
  timeline.items = [item()];
  const read = vi.fn().mockResolvedValue(undefined);
  const instance = render(TimelineReadReceipt, {
    props: { timeline, visibleEventId: '$latest', atLatest: true, onRead: read },
  });
  await tick();
  await vi.advanceTimersByTimeAsync(500);
  expect(read).toHaveBeenCalledWith('$latest');
  instance.unmount();
  vi.useRealTimers();
});

function itemWithId(id: string): TimelineItemView {
  return { ...item(), id, event_id: `$${id}` };
}

test('new messages stay unread after native focus is lost while the page reports visible', async () => {
  vi.useFakeTimers();
  const timeline = new RoomTimeline({} as CoreClient);
  timeline.items = [itemWithId('a')];
  const read = vi.fn().mockResolvedValue(undefined);
  const props = $state({ timeline, visibleEventId: '$a', onRead: read });
  const instance = render(TimelineReadReceipt, { props });

  await tick();
  await vi.advanceTimersByTimeAsync(500);
  expect(read).toHaveBeenCalledExactlyOnceWith('$a');

  native.onFocus?.(false);
  await tick();
  timeline.items = [...timeline.items, itemWithId('b')];
  props.visibleEventId = '$b';
  await tick();
  await vi.advanceTimersByTimeAsync(1000);

  expect(document.visibilityState).toBe('visible');
  expect(document.hasFocus()).toBe(true);
  expect(read).toHaveBeenCalledTimes(1);

  native.onFocus?.(true);
  await tick();
  await vi.advanceTimersByTimeAsync(500);
  expect(read).toHaveBeenNthCalledWith(2, '$b');
  instance.unmount();
});

test('a fast scroll across many rows sends one receipt for the newest', async () => {
  vi.useFakeTimers();
  const timeline = new RoomTimeline({} as CoreClient);
  timeline.items = [itemWithId('a'), itemWithId('b'), itemWithId('c')];
  const read = vi.fn(() => Promise.resolve(undefined));
  const props = $state({ timeline, visibleEventId: '$a', onRead: read });
  const instance = render(TimelineReadReceipt, { props });

  await tick();
  props.visibleEventId = '$b';
  await tick();
  props.visibleEventId = '$c';
  await tick();

  expect(read).not.toHaveBeenCalled();

  await vi.advanceTimersByTimeAsync(500);

  expect(read).toHaveBeenCalledTimes(1);
  expect(read).toHaveBeenCalledWith('$c');

  instance.unmount();
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
  const instance = render(TimelineReadReceipt, { props });

  await tick();
  await vi.advanceTimersByTimeAsync(500);
  props.visibleEventId = '$b';
  await tick();
  await vi.advanceTimersByTimeAsync(500);

  expect(read).toHaveBeenCalledTimes(1);
  first.resolve(undefined);
  await tick();

  expect(read).toHaveBeenNthCalledWith(2, '$b');
  instance.unmount();
  vi.useRealTimers();
});

test('drops an older candidate queued while a newer receipt is pending', async () => {
  vi.useFakeTimers();
  const timeline = new RoomTimeline({} as CoreClient);
  timeline.items = [itemWithId('a'), itemWithId('b'), itemWithId('c')];
  const newest = deferred<undefined>();
  const read = vi.fn(() => newest.promise);
  const props = $state({ timeline, visibleEventId: '$c', onRead: read });
  const instance = render(TimelineReadReceipt, { props });

  await tick();
  await vi.advanceTimersByTimeAsync(500);
  props.visibleEventId = '$b';
  await tick();
  newest.resolve(undefined);
  await tick();

  expect(read).toHaveBeenCalledTimes(1);
  instance.unmount();
  vi.useRealTimers();
});

test('does not flush a queued receipt after unmount', async () => {
  vi.useFakeTimers();
  const timeline = new RoomTimeline({} as CoreClient);
  timeline.items = [itemWithId('a'), itemWithId('b'), itemWithId('c')];
  const first = deferred<undefined>();
  const read = vi.fn(() => first.promise);
  const props = $state({ timeline, visibleEventId: '$a', onRead: read });
  const instance = render(TimelineReadReceipt, { props });

  await tick();
  await vi.advanceTimersByTimeAsync(500);
  props.visibleEventId = '$c';
  await tick();
  instance.unmount();
  first.resolve(undefined);
  await tick();

  expect(read).toHaveBeenCalledTimes(1);
  vi.useRealTimers();
});

test('keeps the newest queued receipt when the viewport moves backward', async () => {
  vi.useFakeTimers();
  const timeline = new RoomTimeline({} as CoreClient);
  timeline.items = [itemWithId('a'), itemWithId('b'), itemWithId('c')];
  const first = deferred<undefined>();
  const read = vi
    .fn()
    .mockImplementationOnce(() => first.promise)
    .mockResolvedValue(undefined);
  const props = $state({ timeline, visibleEventId: '$a', onRead: read });
  const instance = render(TimelineReadReceipt, { props });

  await tick();
  await vi.advanceTimersByTimeAsync(500);
  props.visibleEventId = '$c';
  await tick();
  props.visibleEventId = '$b';
  await tick();
  first.resolve(undefined);
  await tick();

  expect(read).toHaveBeenNthCalledWith(2, '$c');
  instance.unmount();
  vi.useRealTimers();
});

test('flushes the queued newer receipt after hiding during an in-flight request', async () => {
  vi.useFakeTimers();
  const timeline = new RoomTimeline({} as CoreClient);
  timeline.items = [itemWithId('a'), itemWithId('b'), itemWithId('c')];
  const first = deferred<undefined>();
  const read = vi
    .fn()
    .mockImplementationOnce(() => first.promise)
    .mockResolvedValue(undefined);
  const props = $state({ timeline, visibleEventId: '$a', onRead: read });
  const instance = render(TimelineReadReceipt, { props });

  await tick();
  await vi.advanceTimersByTimeAsync(500);
  props.visibleEventId = '$c';
  await tick();
  Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
  await tick();
  first.resolve(undefined);
  await tick();

  expect(read).toHaveBeenNthCalledWith(2, '$c');
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  instance.unmount();
  vi.useRealTimers();
});

test('hiding the document sends the pending receipt rather than losing it', async () => {
  vi.useFakeTimers();
  const timeline = new RoomTimeline({} as CoreClient);
  timeline.items = [itemWithId('a')];
  const read = vi.fn(() => Promise.resolve(undefined));
  const instance = render(TimelineReadReceipt, {
    props: { timeline, visibleEventId: '$a', onRead: read },
  });

  await tick();
  expect(read).not.toHaveBeenCalled();

  Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
  document.dispatchEvent(new Event('visibilitychange'));
  await tick();

  expect(read).toHaveBeenCalledWith('$a');

  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  instance.unmount();
  vi.useRealTimers();
});

test('unread navigation blocks receipts even when the viewport is at latest', async () => {
  vi.useFakeTimers();
  const timeline = new RoomTimeline({} as CoreClient);
  timeline.items = [item()];
  const read = vi.fn().mockResolvedValue(undefined);
  const props = $state({ timeline, visibleEventId: '$latest', enabled: false, onRead: read });
  const instance = render(TimelineReadReceipt, { props });
  await tick();
  await vi.advanceTimersByTimeAsync(500);
  expect(read).not.toHaveBeenCalled();
  props.enabled = true;
  await tick();
  await vi.advanceTimersByTimeAsync(500);
  expect(read).toHaveBeenCalledWith('$latest');
  instance.unmount();
  vi.useRealTimers();
});

test('blocking receipts discards a previously queued receipt', async () => {
  vi.useFakeTimers();
  const timeline = new RoomTimeline({} as CoreClient);
  timeline.items = [item()];
  const read = vi.fn().mockResolvedValue(undefined);
  const props = $state({ timeline, visibleEventId: '$latest', enabled: true, onRead: read });
  const instance = render(TimelineReadReceipt, { props });
  await tick();
  props.enabled = false;
  await tick();
  await vi.advanceTimersByTimeAsync(500);
  expect(read).not.toHaveBeenCalled();
  instance.unmount();
  vi.useRealTimers();
});
