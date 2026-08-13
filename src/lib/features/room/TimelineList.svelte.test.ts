// @vitest-environment happy-dom

import { mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import type { TimelineItemView } from '@/generated/TimelineItemView';
import type { CoreClient } from '$lib/core/client.svelte';
import { RoomTimeline } from '$lib/rooms/timeline.svelte';

import TimelineList from './TimelineList.svelte';

let animationFrames: FrameRequestCallback[];

beforeEach(() => {
  animationFrames = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    animationFrames.push(callback);
    return animationFrames.length;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

function timeline(): RoomTimeline {
  return new RoomTimeline({} as CoreClient);
}

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

async function runAnimationFrames(): Promise<void> {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve();
    for (const callback of animationFrames.splice(0)) callback(0);
    await tick();
  }
}

function viewport(): HTMLDivElement {
  const element = document.querySelector('.viewport');
  if (!(element instanceof HTMLDivElement)) throw new Error('timeline viewport not found');
  Object.defineProperties(element, {
    clientHeight: { configurable: true, value: 100 },
    scrollHeight: { configurable: true, value: 100 },
  });
  return element;
}

test('fills a short live timeline after its initial page settles', async () => {
  const roomTimeline = timeline();
  roomTimeline.items = [item('latest')];
  const history = vi.fn(() => Promise.resolve(false));
  const instance = mount(TimelineList, {
    target: document.body,
    props: {
      timeline: roomTimeline,
      onRequestHistory: history,
      onRequestFuture: async () => {},
      onRead: async () => {},
    },
  });

  viewport();
  await tick();
  await runAnimationFrames();

  expect(history).toHaveBeenCalledTimes(1);
  await unmount(instance);
});

test('does not eagerly paginate a scrollable initial timeline', async () => {
  const roomTimeline = timeline();
  roomTimeline.items = Array.from({ length: 20 }, (_, index) => item(String(index)));
  const history = vi.fn(() => Promise.resolve(false));
  const instance = mount(TimelineList, {
    target: document.body,
    props: {
      timeline: roomTimeline,
      onRequestHistory: history,
      onRequestFuture: async () => {},
      onRead: async () => {},
    },
  });

  const element = viewport();
  Object.defineProperties(element, {
    scrollHeight: { configurable: true, value: 1_000 },
    scrollTop: { configurable: true, writable: true, value: 900 },
  });
  await tick();
  await runAnimationFrames();

  expect(history).not.toHaveBeenCalled();
  await unmount(instance);
});

test('does not leave follow mode for a virtualizer scroll correction', async () => {
  const roomTimeline = timeline();
  roomTimeline.items = Array.from({ length: 20 }, (_, index) => item(String(index)));
  roomTimeline.backwardPagination = 'end';
  const history = vi.fn(() => Promise.resolve(false));
  const instance = mount(TimelineList, {
    target: document.body,
    props: {
      timeline: roomTimeline,
      onRequestHistory: history,
      onRequestFuture: async () => {},
      onRead: async () => {},
    },
  });

  const element = viewport();
  Object.defineProperties(element, {
    scrollHeight: { configurable: true, value: 1_000 },
    scrollTop: { configurable: true, writable: true, value: 900 },
  });
  await tick();
  await runAnimationFrames();

  element.scrollTop = 700;
  element.dispatchEvent(new Event('scroll'));
  await tick();

  expect(document.querySelector('.jump-to-latest')).toBeNull();
  expect(history).not.toHaveBeenCalled();
  await unmount(instance);
});

test('requests one history page until the viewport leaves the top threshold', async () => {
  const roomTimeline = timeline();
  roomTimeline.items = Array.from({ length: 20 }, (_, index) => item(String(index)));
  roomTimeline.mode = { kind: 'live' };
  const history = vi.fn(() => Promise.resolve(false));
  const instance = mount(TimelineList, {
    target: document.body,
    props: {
      timeline: roomTimeline,
      onRequestHistory: history,
      onRequestFuture: async () => {},
      onRead: async () => {},
    },
  });

  const element = viewport();
  Object.defineProperties(element, {
    scrollHeight: { configurable: true, value: 1_000 },
    scrollTop: { configurable: true, writable: true, value: 900 },
  });
  await tick();
  await runAnimationFrames();
  history.mockClear();
  element.scrollTop = 0;

  element.dispatchEvent(new WheelEvent('wheel', { deltaY: -200 }));
  element.scrollTop = 20;
  element.dispatchEvent(new Event('scroll'));
  element.dispatchEvent(new Event('scroll'));
  await tick();

  expect(history).toHaveBeenCalledTimes(1);
  await unmount(instance);
});

test('requests history from upward input when already at the top', async () => {
  const roomTimeline = timeline();
  roomTimeline.items = Array.from({ length: 20 }, (_, index) => item(String(index)));
  const history = vi.fn(() => Promise.resolve(false));
  const instance = mount(TimelineList, {
    target: document.body,
    props: {
      timeline: roomTimeline,
      onRequestHistory: history,
      onRequestFuture: async () => {},
      onRead: async () => {},
    },
  });

  const element = viewport();
  Object.defineProperties(element, {
    scrollHeight: { configurable: true, value: 1_000 },
    scrollTop: { configurable: true, writable: true, value: 0 },
  });
  await tick();
  await runAnimationFrames();
  history.mockClear();
  element.scrollTop = 0;

  element.dispatchEvent(new WheelEvent('wheel', { deltaY: -200 }));
  await tick();

  expect(history).toHaveBeenCalledTimes(1);
  await unmount(instance);
});

test('a fresh upward input requests the next settled history page', async () => {
  const roomTimeline = timeline();
  roomTimeline.items = Array.from({ length: 20 }, (_, index) => item(String(index)));
  const history = vi.fn(() => Promise.resolve(false));
  const instance = mount(TimelineList, {
    target: document.body,
    props: {
      timeline: roomTimeline,
      onRequestHistory: history,
      onRequestFuture: async () => {},
      onRead: async () => {},
    },
  });

  const element = viewport();
  Object.defineProperties(element, {
    scrollHeight: { configurable: true, value: 1_000 },
    scrollTop: { configurable: true, writable: true, value: 0 },
  });
  await tick();
  await runAnimationFrames();
  history.mockClear();
  element.scrollTop = 0;

  element.dispatchEvent(new WheelEvent('wheel', { deltaY: -200 }));
  roomTimeline.items = [item('older'), ...roomTimeline.items];
  await tick();
  await runAnimationFrames();
  element.scrollTop = 0;
  element.dispatchEvent(new WheelEvent('wheel', { deltaY: -200 }));
  await tick();

  expect(history).toHaveBeenCalledTimes(2);
  await unmount(instance);
});

test('retries marking the latest event read after a failed request', async () => {
  const roomTimeline = timeline();
  roomTimeline.items = [item('latest')];
  roomTimeline.backwardPagination = 'end';
  const read = vi
    .fn<(_: string) => Promise<void>>()
    .mockRejectedValueOnce(new Error('temporary failure'))
    .mockResolvedValueOnce();
  const instance = mount(TimelineList, {
    target: document.body,
    props: {
      timeline: roomTimeline,
      onRequestHistory: () => Promise.resolve(false),
      onRequestFuture: async () => {},
      onRead: read,
    },
  });

  viewport();
  await tick();
  await runAnimationFrames();
  await Promise.resolve();
  expect(read).toHaveBeenCalledTimes(1);
  await Promise.resolve();

  roomTimeline.items = [...roomTimeline.items];
  await tick();

  expect(read).toHaveBeenCalledTimes(2);
  await unmount(instance);
});
