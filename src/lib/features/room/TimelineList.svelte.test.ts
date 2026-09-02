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
vi.mock('#lib/personas/personas.svelte.js', () => ({
  usePersonaStore: () => ({ personas: [], load: () => Promise.resolve() }),
}));

import TimelineListHarness from './TimelineListHarness.test.svelte';

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

function readMarker(id: string): TimelineItemView {
  return { ...item(id), event_id: null, content: { kind: 'read_marker' } };
}

function hiddenItem(id: string): TimelineItemView {
  return {
    ...item(id),
    content: {
      kind: 'profile_change',
      user_id: '@alice:example.org',
      display_name: { old: 'Alice', new: id },
      avatar_changed: false,
    },
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
    offsetHeight: { configurable: true, value: 100 },
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
  const instance = mount(TimelineListHarness, {
    target: document.body,
    props: {
      list: {
        timeline: roomTimeline,
        onRequestHistory: history,
        onRequestFuture: async () => {},
        onRead: async () => {},
      },
    },
  });

  viewport();
  await tick();
  await runAnimationFrames();

  expect(history).toHaveBeenCalledTimes(3);
  await unmount(instance);
});

test('continues filling an underfilled room after the opening handoff', async () => {
  const roomTimeline = timeline();
  roomTimeline.items = [item('latest')];
  const history = vi.fn(() => Promise.resolve(false));
  const instance = mount(TimelineListHarness, {
    target: document.body,
    props: {
      list: {
        timeline: roomTimeline,
        onRequestHistory: history,
        onRequestFuture: async () => {},
        onRead: async () => {},
      },
    },
  });

  viewport();
  await tick();
  await runAnimationFrames();
  await runAnimationFrames();
  await runAnimationFrames();

  expect(history.mock.calls.length).toBeGreaterThan(TIMELINE_LAYOUT.initialFillMaxPages);
  const placeholder = document.querySelector('.timeline-placeholder.history');
  expect(placeholder).toBeInstanceOf(HTMLElement);
  expect(placeholder?.classList.contains('items')).toBe(true);
  expect(placeholder?.querySelector('.item .message.placeholder-message')).toBeInstanceOf(
    HTMLElement
  );
  await unmount(instance);
});

test('reveals a short timeline at once and pads it out behind the reader', async () => {
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
  const instance = mount(TimelineListHarness, {
    target: document.body,
    props: {
      list: {
        timeline: roomTimeline,
        onRequestHistory: history,
        onRequestFuture: async () => {},
        onRead: async () => {},
      },
    },
  });

  viewport();
  await tick();
  await runAnimationFrames();

  // Nothing to land on, so the reader sees the latest message while the fill runs.
  expect(timelineViewport().classList.contains('initial')).toBe(false);
  expect(history).toHaveBeenCalledTimes(1);

  releaseHistory();
  await runAnimationFrames();

  expect(timelineViewport().classList.contains('initial')).toBe(false);
  await unmount(instance);
});

test('keeps a timeline with an unread marker hidden until it has landed on it', async () => {
  const roomTimeline = timeline();
  roomTimeline.items = [readMarker('marker'), item('latest')];
  let releaseHistory = (): void => {};
  const history = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        releaseHistory = () => {
          resolve(true);
        };
      })
  );
  const instance = mount(TimelineListHarness, {
    target: document.body,
    props: {
      list: {
        timeline: roomTimeline,
        onRequestHistory: history,
        onRequestFuture: async () => {},
        onRead: async () => {},
      },
    },
  });

  Object.defineProperty(viewport(), 'clientHeight', { configurable: true, value: 10_000 });
  await tick();
  await runAnimationFrames();

  // The fill is needed, and revealing now would show the end then jump up.
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
  const instance = mount(TimelineListHarness, {
    target: document.body,
    props: {
      list: {
        timeline: roomTimeline,
        onRequestHistory: history,
        onRequestFuture: async () => {},
        onRead: async () => {},
      },
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
  const instance = mount(TimelineListHarness, {
    target: document.body,
    props: {
      list: {
        timeline: roomTimeline,
        onRequestHistory: () => Promise.resolve(false),
        onRequestFuture: async () => {},
        onRead: async () => {},
      },
    },
  });

  viewport();
  await tick();
  await unmount(instance);
  await runAnimationFrames();
});

test('leaves follow mode for a scroll it did not write, whatever produced it', async () => {
  const roomTimeline = timeline();
  roomTimeline.items = Array.from({ length: 20 }, (_, index) => item(String(index)));
  roomTimeline.backwardPagination = 'end';
  const history = vi.fn(() => Promise.resolve(false));
  const instance = mount(TimelineListHarness, {
    target: document.body,
    props: {
      list: {
        timeline: roomTimeline,
        onRequestHistory: history,
        onRequestFuture: async () => {},
        onRead: async () => {},
      },
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

  expect(document.querySelector('.jump-to-latest')).not.toBeNull();
  expect(history).not.toHaveBeenCalled();
  await unmount(instance);
});

test('requests one history page until the viewport leaves the top threshold', async () => {
  const roomTimeline = timeline();
  roomTimeline.items = Array.from({ length: 20 }, (_, index) => item(String(index)));
  roomTimeline.mode = { kind: 'live' };
  const history = vi.fn(() => Promise.resolve(false));
  const instance = mount(TimelineListHarness, {
    target: document.body,
    props: {
      list: {
        timeline: roomTimeline,
        onRequestHistory: history,
        onRequestFuture: async () => {},
        onRead: async () => {},
      },
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
  const instance = mount(TimelineListHarness, {
    target: document.body,
    props: {
      list: {
        timeline: roomTimeline,
        onRequestHistory: history,
        onRequestFuture: async () => {},
        onRead: async () => {},
      },
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
  const instance = mount(TimelineListHarness, {
    target: document.body,
    props: {
      list: {
        timeline: roomTimeline,
        onRequestHistory: history,
        onRequestFuture: async () => {},
        onRead: async () => {},
      },
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
  const instance = mount(TimelineListHarness, {
    target: document.body,
    props: {
      list: {
        timeline: roomTimeline,
        onRequestHistory: history,
        onRequestFuture: async () => {},
        onRead: async () => {},
      },
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
    const instance = mount(TimelineListHarness, {
      target: document.body,
      props: {
        list: {
          timeline: roomTimeline,
          onRequestHistory: history,
          onRequestFuture: async () => {},
          onRead: async () => {},
        },
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
    await runAnimationFrames();
    expect(history).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(299);
    expect(history).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(history).toHaveBeenCalledTimes(2);
    await runAnimationFrames();
    await vi.advanceTimersByTimeAsync(300);
    expect(history).toHaveBeenCalledTimes(3);
    await runAnimationFrames();
    await vi.advanceTimersByTimeAsync(300);
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
    const instance = mount(TimelineListHarness, {
      target: document.body,
      props: {
        list: {
          timeline: roomTimeline,
          onRequestHistory: history,
          onRequestFuture: async () => {},
          onRead: async () => {},
        },
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
  vi.useFakeTimers();
  const roomTimeline = timeline();
  roomTimeline.items = [item('latest')];
  roomTimeline.backwardPagination = 'end';
  const read = vi
    .fn<(_: string) => Promise<void>>()
    .mockRejectedValueOnce(new Error('temporary failure'))
    .mockResolvedValueOnce();
  const instance = mount(TimelineListHarness, {
    target: document.body,
    props: {
      list: {
        timeline: roomTimeline,
        onRequestHistory: () => Promise.resolve(false),
        onRequestFuture: async () => {},
        onRead: read,
      },
    },
  });

  viewport();
  await tick();
  await runAnimationFrames();
  await vi.advanceTimersByTimeAsync(500);
  expect(read).toHaveBeenCalledTimes(1);
  await Promise.resolve();

  roomTimeline.items = [...roomTimeline.items];
  await tick();
  await vi.advanceTimersByTimeAsync(500);

  expect(read).toHaveBeenCalledTimes(2);
  await unmount(instance);
  vi.useRealTimers();
});

const ROW = 100;
const VIEWPORT = 100;

function layOutRows(): void {
  const rect = (): DOMRect =>
    ({ top: 0, left: 0, right: 300, bottom: ROW, width: 300, height: ROW }) as DOMRect;
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(rect);
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: ROW });
}

interface LiveTimeline {
  instance: Record<string, unknown>;
  element: HTMLDivElement;
  end: number;
  setScrollHeight: (height: number) => void;
}

/** Every row lays out at `ROW`, so the virtualiser and the stubbed box agree. */
async function mountLive(roomTimeline: RoomTimeline): Promise<LiveTimeline> {
  layOutRows();
  roomTimeline.mode = { kind: 'live' };
  roomTimeline.backwardPagination = 'end';
  const instance = mount(TimelineListHarness, {
    target: document.body,
    props: {
      list: {
        timeline: roomTimeline,
        onRequestHistory: () => Promise.resolve(false),
        onRequestFuture: async () => {},
        onRead: async () => {},
      },
    },
  });
  let scrollHeight = roomTimeline.items.length * ROW;
  const element = viewport();
  Object.defineProperties(element, {
    scrollHeight: { configurable: true, get: () => scrollHeight },
    scrollTop: { configurable: true, writable: true, value: 0 },
  });
  await tick();
  await runAnimationFrames();
  // The virtualiser only learns an offset from a scroll event, and happy-dom's
  // `scrollTop` setter dispatches none.
  element.dispatchEvent(new Event('scroll'));
  await tick();
  await runAnimationFrames();
  return {
    instance,
    element,
    end: scrollHeight - VIEWPORT,
    setScrollHeight: (next) => {
      scrollHeight = next;
    },
  };
}

test('a backward pagination adds a scrollable history placeholder', async () => {
  const roomTimeline = timeline();
  roomTimeline.items = liveItems(20);
  const { instance, element } = await mountLive(roomTimeline);
  element.scrollTop = 0;
  element.dispatchEvent(new Event('scroll'));
  await tick();
  await runAnimationFrames();
  const beforeScroll = element.scrollTop;
  const beforeHeight = contentHeight();

  roomTimeline.backwardPagination = 'loading';
  await tick();
  await runAnimationFrames();

  expect(contentHeight()).toBeGreaterThan(beforeHeight);
  expect(contentHeight() - beforeHeight).toBeGreaterThanOrEqual(100 / 3);
  const placeholder = document.querySelector('.timeline-placeholder.history');
  expect(placeholder).toBeInstanceOf(HTMLElement);
  expect(placeholder?.classList.contains('items')).toBe(true);
  expect(placeholder?.querySelector('.item .message.placeholder-message')).toBeInstanceOf(
    HTMLElement
  );
  expect(element.scrollTop).toBe(beforeScroll);

  roomTimeline.backwardPagination = 'idle';
  await tick();
  await runAnimationFrames();

  expect(contentHeight()).toBe(beforeHeight);
  expect(element.scrollTop).toBe(beforeScroll);

  await unmount(instance);
});

async function dragTo(element: HTMLDivElement, from: number, to: number): Promise<void> {
  touch(element, 'touchstart', from < to ? 200 : 100);
  element.dispatchEvent(new Event('scroll'));
  await tick();
  touch(element, 'touchmove', from < to ? 160 : 140);
  element.scrollTop = to;
  element.dispatchEvent(new Event('scroll'));
  await tick();
}

function anchored(): boolean {
  return document.querySelector('.jump-to-latest') !== null;
}

function liveItems(count: number): TimelineItemView[] {
  return Array.from({ length: count }, (_, index) => item(String(index)));
}

test('reading back inside the near-latest band leaves follow mode', async () => {
  const roomTimeline = timeline();
  roomTimeline.items = liveItems(20);
  const { instance, element, end } = await mountLive(roomTimeline);
  expect(document.querySelectorAll('.item').length).toBeGreaterThan(0);
  expect(anchored()).toBe(false);

  await dragTo(element, end, end - 30);

  expect(anchored()).toBe(true);
  await unmount(instance);
});

test('reading back past the band anchors', async () => {
  const roomTimeline = timeline();
  roomTimeline.items = liveItems(20);
  const { instance, element, end } = await mountLive(roomTimeline);

  await dragTo(element, end, end - 900);

  expect(anchored()).toBe(true);
  await unmount(instance);
});

test('scrolling back to the end restores follow mode', async () => {
  const roomTimeline = timeline();
  roomTimeline.items = liveItems(20);
  const { instance, element, end } = await mountLive(roomTimeline);

  await dragTo(element, end, end - 900);
  expect(anchored()).toBe(true);

  await dragTo(element, end - 900, end);

  expect(anchored()).toBe(false);
  await unmount(instance);
});

test('hides the jump control when a content shrink clamps an anchored reader to the end', async () => {
  const roomTimeline = timeline();
  roomTimeline.items = liveItems(20);
  const { instance, element, end, setScrollHeight } = await mountLive(roomTimeline);

  await dragTo(element, end, end - 900);
  expect(anchored()).toBe(true);

  setScrollHeight(1_000);
  element.scrollTop = 900;
  element.dispatchEvent(new Event('scroll'));
  await tick();

  expect(anchored()).toBe(false);
  await unmount(instance);
});

function contentHeight(): number {
  const element = document.querySelector('.items');
  if (!(element instanceof HTMLElement)) throw new Error('timeline content not found');
  return Number.parseFloat(element.style.height);
}

test('a tab restore keeps the row heights it measured', async () => {
  const roomTimeline = timeline();
  roomTimeline.items = liveItems(20);
  const { instance } = await mountLive(roomTimeline);
  const measured = contentHeight();
  expect(measured).toBeGreaterThan(20 * ROW * 0.5);

  document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
  await runAnimationFrames();

  expect(contentHeight()).toBeGreaterThanOrEqual(measured);
  await unmount(instance);
});

test('a tab restore re-reads a rendered row whose measurement went stale', async () => {
  const roomTimeline = timeline();
  roomTimeline.items = liveItems(20);
  const { instance } = await mountLive(roomTimeline);
  const measured = contentHeight();

  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    value: ROW * 2,
  });
  document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
  await runAnimationFrames();

  expect(contentHeight()).toBeGreaterThan(measured);
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    value: ROW,
  });
  await unmount(instance);
});

test('a wheel notch inside the band also leaves follow mode', async () => {
  const roomTimeline = timeline();
  roomTimeline.items = liveItems(20);
  const { instance, element, end } = await mountLive(roomTimeline);

  element.dispatchEvent(new WheelEvent('wheel', { deltaY: -30 }));
  element.scrollTop = end - 30;
  element.dispatchEvent(new Event('scroll'));
  await tick();

  expect(anchored()).toBe(true);
  await unmount(instance);
});

test('middle-button autoscroll leaves follow mode', async () => {
  const roomTimeline = timeline();
  roomTimeline.items = liveItems(20);
  const { instance, element, end } = await mountLive(roomTimeline);

  element.dispatchEvent(new PointerEvent('pointerdown', { button: 1 }));
  element.scrollTop = end - 30;
  element.dispatchEvent(new Event('scroll'));
  await tick();

  expect(anchored()).toBe(true);

  element.scrollTop = end - 60;
  element.dispatchEvent(new Event('scroll'));
  await tick();

  expect(anchored()).toBe(true);
  expect(element.scrollTop).toBe(end - 60);
  await unmount(instance);
});

test('an upward browser scroll without an input event leaves follow mode', async () => {
  const roomTimeline = timeline();
  roomTimeline.items = liveItems(20);
  const { instance, element, end } = await mountLive(roomTimeline);

  element.scrollTop = end - 30;
  element.dispatchEvent(new Event('scroll'));
  await tick();

  expect(anchored()).toBe(true);
  await unmount(instance);
});

test('a scrollbar drag leaves follow mode like any other reading back', async () => {
  const roomTimeline = timeline();
  roomTimeline.items = liveItems(20);
  const { instance, element, end } = await mountLive(roomTimeline);

  element.dispatchEvent(new PointerEvent('pointerdown', { button: 0 }));
  element.scrollTop = end - 900;
  element.dispatchEvent(new Event('scroll'));
  await tick();

  expect(anchored()).toBe(true);
  await unmount(instance);
});

test('keeps filling past a window of events the settings hide', async () => {
  const roomTimeline = timeline();
  roomTimeline.items = [hiddenItem('renamed')];
  const history = vi.fn(() => Promise.resolve(false));
  const instance = mount(TimelineListHarness, {
    target: document.body,
    props: {
      list: {
        timeline: roomTimeline,
        onRequestHistory: history,
        onRequestFuture: async () => {},
        onRead: async () => {},
      },
    },
  });

  viewport();
  await tick();
  for (let round = 0; round < TIMELINE_LAYOUT.emptyFillMaxPages; round += 1) {
    await runAnimationFrames();
  }

  expect(history).toHaveBeenCalledTimes(TIMELINE_LAYOUT.emptyFillMaxPages);
  await unmount(instance);
});

test('waits out a page in flight when the room opens', async () => {
  const roomTimeline = timeline();
  roomTimeline.items = [item('latest')];
  roomTimeline.backwardPagination = 'loading';
  const history = vi.fn(() => Promise.resolve(false));
  const instance = mount(TimelineListHarness, {
    target: document.body,
    props: {
      list: {
        timeline: roomTimeline,
        onRequestHistory: history,
        onRequestFuture: async () => {},
        onRead: async () => {},
      },
    },
  });

  viewport();
  await tick();
  await runAnimationFrames();

  expect(history).not.toHaveBeenCalled();

  roomTimeline.backwardPagination = 'idle';
  await new Promise((resolve) => setTimeout(resolve, TIMELINE_LAYOUT.initialFillPollInterval * 2));
  await runAnimationFrames();

  expect(history).toHaveBeenCalled();
  await unmount(instance);
});

test('asks for history again when the timeline is cleared mid-session', async () => {
  const roomTimeline = timeline();
  roomTimeline.items = [item('latest')];
  const history = vi.fn(() => Promise.resolve(false));
  const instance = mount(TimelineListHarness, {
    target: document.body,
    props: {
      list: {
        timeline: roomTimeline,
        onRequestHistory: history,
        onRequestFuture: async () => {},
        onRead: async () => {},
      },
    },
  });

  viewport();
  await tick();
  await runAnimationFrames();
  await runAnimationFrames();
  const opening = history.mock.calls.length;

  roomTimeline.items = [];
  await tick();
  await runAnimationFrames();

  expect(history.mock.calls.length).toBeGreaterThan(opening);
  await unmount(instance);
});

test('a cleared timeline is not held back by the start it reached before', async () => {
  const roomTimeline = timeline();
  roomTimeline.items = [item('latest')];
  const history = vi.fn(() => Promise.resolve(true));
  const instance = mount(TimelineListHarness, {
    target: document.body,
    props: {
      list: {
        timeline: roomTimeline,
        onRequestHistory: history,
        onRequestFuture: async () => {},
        onRead: async () => {},
      },
    },
  });

  viewport();
  await tick();
  await runAnimationFrames();
  const opening = history.mock.calls.length;
  expect(opening).toBeGreaterThan(0);

  roomTimeline.items = [];
  await tick();
  await runAnimationFrames();

  expect(history.mock.calls.length).toBeGreaterThan(opening);
  await unmount(instance);
});

test('an empty timeline keeps asking when a page brings nothing but claims the start', async () => {
  const roomTimeline = timeline();
  roomTimeline.items = [item('latest')];
  const history = vi.fn(() => Promise.resolve(true));
  const instance = mount(TimelineListHarness, {
    target: document.body,
    props: {
      list: {
        timeline: roomTimeline,
        onRequestHistory: history,
        onRequestFuture: async () => {},
        onRead: async () => {},
      },
    },
  });

  viewport();
  await tick();
  await runAnimationFrames();

  roomTimeline.items = [];
  await tick();
  await runAnimationFrames();
  await tick();
  const afterClear = history.mock.calls.length;
  expect(afterClear).toBeGreaterThan(0);

  roomTimeline.backwardPagination = 'loading';
  await tick();
  roomTimeline.backwardPagination = 'idle';
  await tick();
  await runAnimationFrames();

  expect(history.mock.calls.length).toBeGreaterThan(afterClear);
  await unmount(instance);
});
