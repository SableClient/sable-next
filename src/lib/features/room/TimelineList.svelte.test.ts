// @vitest-environment happy-dom

import { mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import type { TimelineItemView } from '#src/generated/TimelineItemView';
import type { CoreClient } from '#lib/core/client.svelte.js';
import { RoomTimeline } from '#lib/rooms/timeline.svelte.js';

import { TIMELINE_LAYOUT } from './timeline-layout';

const core = vi.hoisted(() => ({
  fetchMedia: vi.fn<() => Promise<Uint8Array<ArrayBuffer>>>(),
  userProfile: vi.fn().mockRejectedValue(new Error('profile unavailable')),
}));

vi.mock('#lib/core/context.js', () => ({ useCoreClient: () => core }));
vi.mock('#lib/rooms/room-list.svelte.js', () => ({ useRoomList: () => ({ rooms: [] }) }));

import TimelineList from './TimelineList.svelte';

let animationFrames: FrameRequestCallback[];

beforeEach(() => {
  // happy-dom ships no Web Animations API, and the skeleton fades out through it.
  Element.prototype.animate = () =>
    ({
      cancel: () => {},
      effect: null,
      onfinish: null,
      playState: 'finished',
    }) as unknown as Animation;
  animationFrames = [];
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    animationFrames.push(callback);
    return animationFrames.length;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Reflect.deleteProperty(HTMLElement.prototype, 'offsetHeight');
  document.body.replaceChildren();
});

function timeline(): RoomTimeline {
  return new RoomTimeline({} as CoreClient);
}

async function finishWheelGesture(element?: HTMLElement): Promise<void> {
  element?.dispatchEvent(new Event('scrollend'));
  await new Promise((resolve) => setTimeout(resolve, 160));
  await tick();
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
    content: { kind: 'message', body: id, html: id, emote: false, notice: false, edited: false },
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

function touch(element: HTMLElement, type: string, clientY: number): void {
  const event = new Event(type, { bubbles: true });
  Object.defineProperty(event, 'touches', {
    value: { item: (index: number) => (index === 0 ? { clientY } : null) },
  });
  element.dispatchEvent(event);
}

function timelineViewport(): HTMLElement {
  const element = document.querySelector('.timeline-viewport');
  if (!(element instanceof HTMLElement)) throw new Error('timeline viewport wrapper not found');
  return element;
}

test('fills a short live timeline until the server reports the timeline start', async () => {
  const roomTimeline = timeline();
  roomTimeline.items = [item('latest')];
  const history = vi.fn(() => Promise.resolve(history.mock.calls.length >= 3));
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

  expect(history).toHaveBeenCalledTimes(3);
  await unmount(instance);
});

test('bounds the opening fill when the viewport never fills', async () => {
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
  await runAnimationFrames();

  expect(history).toHaveBeenCalledTimes(TIMELINE_LAYOUT.initialFillMaxPages);
  await unmount(instance);
});

test('waits for a terminal page to settle before revealing the timeline', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  try {
    const roomTimeline = timeline();
    roomTimeline.items = [item('latest')];
    // Production ordering: `paginate` resolves before the diff that settles it.
    const history = vi.fn(() => {
      roomTimeline.backwardPagination = 'loading';
      return Promise.resolve(true);
    });
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
    expect(timelineViewport().classList.contains('initial')).toBe(true);

    roomTimeline.backwardPagination = 'end';
    await vi.advanceTimersByTimeAsync(TIMELINE_LAYOUT.initialFillPollInterval);
    await runAnimationFrames();

    expect(history).toHaveBeenCalledTimes(1);
    expect(timelineViewport().classList.contains('initial')).toBe(false);
    await unmount(instance);
  } finally {
    vi.useRealTimers();
  }
});

test('reveals the timeline when a page never settles', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  try {
    const roomTimeline = timeline();
    roomTimeline.items = [item('latest')];
    const history = vi.fn(() => {
      roomTimeline.backwardPagination = 'loading';
      return Promise.resolve(false);
    });
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
    expect(timelineViewport().classList.contains('initial')).toBe(true);

    await vi.advanceTimersByTimeAsync(TIMELINE_LAYOUT.initialFillSettleTimeout);
    await runAnimationFrames();

    expect(timelineViewport().classList.contains('initial')).toBe(false);
    await unmount(instance);
  } finally {
    vi.useRealTimers();
  }
});

test('keeps the timeline hidden until the opening fill settles', async () => {
  const roomTimeline = timeline();
  roomTimeline.items = [item('latest')];
  let releaseHistory = (): void => {};
  const history = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        releaseHistory = () => {
          resolve(true);
        };
      })
  );
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
  expect(timelineViewport().classList.contains('initial')).toBe(true);

  releaseHistory();
  await runAnimationFrames();

  expect(timelineViewport().classList.contains('initial')).toBe(false);
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
  expect(element.getAttribute('tabindex')).toBe('0');
  Object.defineProperties(element, {
    scrollHeight: { configurable: true, value: 1_000 },
    scrollTop: { configurable: true, writable: true, value: 900 },
  });
  await tick();
  await runAnimationFrames();

  expect(history).not.toHaveBeenCalled();
  await unmount(instance);
});

test('does not read a viewport removed during initial positioning', async () => {
  const roomTimeline = timeline();
  roomTimeline.items = [item('latest')];
  const instance = mount(TimelineList, {
    target: document.body,
    props: {
      timeline: roomTimeline,
      onRequestHistory: () => Promise.resolve(false),
      onRequestFuture: async () => {},
      onRead: async () => {},
    },
  });

  viewport();
  await tick();
  await unmount(instance);
  await runAnimationFrames();
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
  element.dispatchEvent(new WheelEvent('wheel', { deltaY: -200 }));
  element.dispatchEvent(new Event('scroll'));
  await finishWheelGesture(element);

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
  await finishWheelGesture(element);

  expect(history).toHaveBeenCalledTimes(1);
  await unmount(instance);
});

test('requests history before an upward wheel gesture settles', async () => {
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
    scrollTop: { configurable: true, writable: true, value: 200 },
  });
  await tick();
  await runAnimationFrames();
  history.mockClear();

  element.dispatchEvent(new WheelEvent('wheel', { deltaY: -200 }));
  element.scrollTop = 0;
  element.dispatchEvent(new Event('scroll'));
  await tick();

  expect(history).toHaveBeenCalledTimes(1);
  await finishWheelGesture(element);
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
  await finishWheelGesture(element);
  expect(history).toHaveBeenCalledTimes(1);
  roomTimeline.items = [item('older'), ...roomTimeline.items];
  await tick();
  await runAnimationFrames();
  element.scrollTop = 20;
  element.dispatchEvent(new Event('scroll'));
  await tick();
  element.scrollTop = 0;
  element.dispatchEvent(new WheelEvent('wheel', { deltaY: -200 }));
  await finishWheelGesture(element);

  expect(history).toHaveBeenCalledTimes(2);
  await unmount(instance);
});

test('rate limits and bounds sparse history fill', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  try {
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
    history.mockClear();
    element.scrollTop = 0;

    element.dispatchEvent(new WheelEvent('wheel', { deltaY: -200 }));
    await tick();
    await Promise.resolve();
    expect(history).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(299);
    expect(history).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(history).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(600);
    expect(history).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(history).toHaveBeenCalledTimes(4);

    await unmount(instance);
  } finally {
    vi.useRealTimers();
  }
});

test('cancels sparse history fill on downward input', async () => {
  vi.useFakeTimers();
  try {
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
    history.mockClear();
    element.scrollTop = 0;

    element.dispatchEvent(new WheelEvent('wheel', { deltaY: -200 }));
    await tick();
    element.dispatchEvent(new WheelEvent('wheel', { deltaY: 200 }));
    await vi.advanceTimersByTimeAsync(1_000);

    expect(history).toHaveBeenCalledTimes(1);
    await unmount(instance);
  } finally {
    vi.useRealTimers();
  }
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

test('reading back inside the near-latest band leaves follow mode', async () => {
  const rect = (): DOMRect =>
    ({ top: 0, left: 0, right: 300, bottom: 100, width: 300, height: 100 }) as DOMRect;
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(rect);
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    value: 10,
  });

  const roomTimeline = timeline();
  roomTimeline.items = Array.from({ length: 20 }, (_, index) => item(String(index)));
  roomTimeline.mode = { kind: 'live' };
  roomTimeline.backwardPagination = 'end';
  const instance = mount(TimelineList, {
    target: document.body,
    props: {
      timeline: roomTimeline,
      onRequestHistory: () => Promise.resolve(false),
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
  expect(document.querySelectorAll('.item').length).toBeGreaterThan(0);

  touch(element, 'touchstart', 100);
  element.dispatchEvent(new Event('scroll'));
  await tick();

  touch(element, 'touchmove', 140);
  element.scrollTop = 870;
  element.dispatchEvent(new Event('scroll'));
  await tick();

  expect(document.querySelector('.jump-to-latest')).not.toBeNull();
  await unmount(instance);
});
