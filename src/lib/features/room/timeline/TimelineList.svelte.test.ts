// @vitest-environment happy-dom

import { render, screen, within } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { createRawSnippet, tick } from 'svelte';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import type { TimelineItemView } from '#src/generated/protocol';
import type { CoreClient } from '#lib/core/client.svelte.js';
import { RoomTimeline } from '#lib/rooms/timeline.svelte.js';

import { TimelineWindow } from '#lib/timeline/timeline-window.js';
import { setPreference } from '#lib/settings/preferences.svelte.js';
import { TIMELINE_LAYOUT } from './timeline-layout';
import { MAX_EMPTY_REFILLS } from './timeline-pagination.svelte.js';

vi.mock('#lib/core/context.js');
vi.mock('#lib/platform/overlay-back.svelte.js', () => ({
  holdOverlayBack: () => {},
  afterOverlayPops: () => Promise.resolve(),
}));
vi.mock('#lib/rooms/room-list.svelte.js', () => ({ useRoomList: () => ({ rooms: [] }) }));
vi.mock('#lib/personas/personas.svelte.js', () => ({
  usePersonaStore: () => ({ personas: [], load: () => Promise.resolve() }),
}));
vi.mock('../messages/event-items.svelte.js', () => ({
  useEventItems: () => ({ get: () => undefined }),
}));

import TimelineListHarness from './TimelineListHarness.test.svelte';
import { core } from '#lib/core/__mocks__/context.js';

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
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement
  ) {
    const viewport = document.querySelector<HTMLElement>('.viewport');
    const content = document.querySelector<HTMLElement>('.window-rows');
    const rows = Array.from(content?.children ?? []) as HTMLElement[];
    const heights = rows.map((row) => row.offsetHeight || 72);
    const total = heights.reduce((sum, height) => sum + height, 0);
    if (this === content) return new DOMRect(0, 0, 300, total);
    const index = rows.indexOf(this);
    if (index >= 0) {
      const top =
        Number.parseFloat((content?.parentElement as HTMLElement | null)?.style.height ?? '0') -
        Number.parseFloat(content?.style.bottom ?? '0') -
        total +
        heights.slice(0, index).reduce((sum, value) => sum + value, 0) -
        (viewport?.scrollTop ?? 0);
      return new DOMRect(0, top, 300, heights[index]);
    }
    return new DOMRect(0, 0, 300, viewport?.clientHeight ?? 100);
  });
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    animationFrames.push(callback);
    return animationFrames.length;
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Reflect.deleteProperty(HTMLElement.prototype, 'offsetHeight');
});

function timeline(): RoomTimeline {
  const result = new RoomTimeline({} as CoreClient);
  result.hasSnapshot = true;
  return result;
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
    read_timestamps: {},
    per_message_profile: null,
    bundled_link_previews: [],
    link_previews_removed: null,
    mention: 'none',
    forwarded: null,
    forum_title: null,
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
      avatar: null,
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

test('expanding a member group exposes the original event source', async () => {
  const roomTimeline = timeline();
  const source = JSON.stringify({ event_id: '$first' });
  const eventSource = vi.fn(() => Promise.resolve(source));
  Object.assign(core.commands, { eventSource });
  roomTimeline.items = ['first', 'last'].map((id): TimelineItemView => ({
    ...item(id),
    content: {
      kind: 'membership',
      change: 'joined',
      user_id: '@alice:example.org',
      display_name: 'Alice',
      reason: null,
    },
  }));
  roomTimeline.backwardPagination = 'end';
  render(TimelineListHarness, {
    props: {
      list: {
        timeline: roomTimeline,
        roomId: '!room:example.org',
        onRequestHistory: () => Promise.resolve(true),
        onRequestFuture: async () => {},
        onRead: async () => {},
      },
    },
  });
  viewport();
  await runAnimationFrames();

  const toggle = screen.getByRole('button', { name: 'Show 2 events' });
  toggle.focus();
  await userEvent.keyboard('{Enter}');
  await runAnimationFrames();
  expect(toggle).toHaveAttribute('aria-expanded', 'true');
  const rows = document.querySelectorAll('.member-group-events .event-row');
  expect(rows).toHaveLength(2);
  await userEvent.pointer({ keys: '[MouseRight]', target: rows[0] });
  await runAnimationFrames();
  await userEvent.click(screen.getByRole('menuitem', { name: 'View source' }));
  await runAnimationFrames();
  expect(eventSource).toHaveBeenCalledWith('!room:example.org', '$first');
  expect(screen.getByRole('dialog', { name: 'Message source' })).toHaveTextContent(source);
});

test('fills a short live timeline until the server reports the timeline start', async () => {
  const roomTimeline = timeline();
  roomTimeline.items = [item('latest')];
  const history = vi.fn(() => Promise.resolve(history.mock.calls.length >= 3));
  render(TimelineListHarness, {
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
});

test('announces new arrivals separately from virtualized history', async () => {
  const roomTimeline = timeline();
  roomTimeline.items = [item('initial')];
  roomTimeline.backwardPagination = 'end';
  render(TimelineListHarness, {
    props: {
      list: {
        timeline: roomTimeline,
        onRequestHistory: () => Promise.resolve(true),
        onRequestFuture: async () => {},
        onRead: async () => {},
      },
    },
  });
  viewport();
  await runAnimationFrames();
  expect(document.querySelector('[role="log"]')?.getAttribute('aria-live')).toBe('off');
  const announcement = () =>
    document.querySelector('[data-timeline-announcements]')?.textContent.trim();
  expect(announcement()).toBe('');
  roomTimeline.items = [item('history'), ...roomTimeline.items];
  await runAnimationFrames();
  expect(announcement()).toBe('');
  roomTimeline.items = [...roomTimeline.items, item('new')];
  await runAnimationFrames();
  expect(announcement()).toBe('1 new message');
  roomTimeline.items = [...roomTimeline.items, { ...item('own'), is_own: true }];
  await runAnimationFrames();
  expect(announcement()).toBe('1 new message');
});

test('a permalink whose context does not fill the viewport paginates on its own', async () => {
  const roomTimeline = timeline();
  roomTimeline.items = [item('older'), item('target'), item('newer')];
  roomTimeline.mode = { kind: 'focused', eventId: '$target' };
  const future = vi.fn(() => {
    roomTimeline.forwardPagination = 'end';
    return Promise.resolve();
  });
  const history = vi.fn(() => Promise.resolve(true));
  render(TimelineListHarness, {
    props: {
      list: {
        timeline: roomTimeline,
        focusEventId: '$target',
        onRequestHistory: history,
        onRequestFuture: future,
        onRead: async () => {},
      },
    },
  });

  viewport();
  await tick();
  await runAnimationFrames();

  expect(future).toHaveBeenCalled();
});

test('own historical messages added to a permalink do not jump to the end', async () => {
  const roomTimeline = timeline();
  roomTimeline.items = [item('target')];
  roomTimeline.mode = { kind: 'focused', eventId: '$target' };
  roomTimeline.forwardPagination = 'end';
  roomTimeline.backwardPagination = 'end';
  const jumps = vi.spyOn(TimelineWindow.prototype, 'jumpTo');
  render(TimelineListHarness, {
    props: {
      list: {
        timeline: roomTimeline,
        focusEventId: '$target',
        onRequestHistory: () => Promise.resolve(true),
        onRequestFuture: async () => {},
        onRead: async () => {},
      },
    },
  });
  viewport();
  await runAnimationFrames();
  jumps.mockClear();

  roomTimeline.items = [...roomTimeline.items, { ...item('own-history'), is_own: true }];
  await runAnimationFrames();

  expect(jumps).not.toHaveBeenCalledWith(null, 'start');
});

test('stops focused automatic pagination after a failed or empty page', async () => {
  const roomTimeline = timeline();
  roomTimeline.items = [item('target')];
  roomTimeline.mode = { kind: 'focused', eventId: '$target' };
  const future = vi.fn(async () => {});
  render(TimelineListHarness, {
    props: {
      list: {
        timeline: roomTimeline,
        focusEventId: '$target',
        onRequestHistory: () => Promise.resolve(true),
        onRequestFuture: future,
        onRead: async () => {},
      },
    },
  });
  viewport();
  for (let page = 0; page < 20; page += 1) await runAnimationFrames();
  expect(future).toHaveBeenCalledTimes(5);
});

test('does not keep retrying a focused page when the timeline reports a load error', async () => {
  const roomTimeline = timeline();
  roomTimeline.items = [item('target')];
  roomTimeline.mode = { kind: 'focused', eventId: '$target' };
  const future = vi.fn(() => {
    roomTimeline.error = 'load_failed';
    return Promise.resolve();
  });
  render(TimelineListHarness, {
    props: {
      list: {
        timeline: roomTimeline,
        focusEventId: '$target',
        onRequestHistory: () => Promise.resolve(true),
        onRequestFuture: future,
        onRead: async () => {},
      },
    },
  });
  viewport();
  for (let page = 0; page < 10; page += 1) await runAnimationFrames();
  expect(future).toHaveBeenCalledTimes(1);
});

test.each(['wheel', 'touchstart', 'pointerdown', 'keydown'])(
  '%s cancels the final focus correction while a page is pending',
  async (type) => {
    const roomTimeline = timeline();
    roomTimeline.items = [item('older'), item('target'), item('newer')];
    roomTimeline.mode = { kind: 'focused', eventId: '$target' };
    let finish!: () => void;
    const future = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );
    render(TimelineListHarness, {
      props: {
        list: {
          timeline: roomTimeline,
          focusEventId: '$target',
          onRequestHistory: () => Promise.resolve(true),
          onRequestFuture: future,
          onRead: async () => {},
        },
      },
    });
    const element = viewport();
    await runAnimationFrames();
    expect(future).toHaveBeenCalledTimes(1);
    const event =
      type === 'wheel'
        ? new WheelEvent(type, { deltaY: -50 })
        : type === 'keydown'
          ? new KeyboardEvent(type, { key: 'PageUp' })
          : new Event(type);
    if (type === 'touchstart') touch(element, type, 200);
    else element.dispatchEvent(event);
    Object.defineProperty(element, 'scrollHeight', { configurable: true, value: 1000 });
    element.scrollTop = 500;
    element.dispatchEvent(new Event('scroll'));
    finish();
    await runAnimationFrames();
    expect(element.scrollTop).toBe(500);
  }
);

test('limits empty opening refills', async () => {
  const roomTimeline = timeline();
  roomTimeline.items = [item('latest')];
  const history = vi.fn(() => Promise.resolve(false));
  render(TimelineListHarness, {
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
  for (let page = 0; page < 30; page += 1) {
    await runAnimationFrames();
  }

  expect(history).toHaveBeenCalledTimes(5);
});

test('fills past several filtered pages until the opening viewport has enough messages', async () => {
  const roomTimeline = timeline();
  roomTimeline.items = [item('latest')];
  const history = vi.fn(() => {
    if (history.mock.calls.length === 5) {
      roomTimeline.items = [item('older'), ...roomTimeline.items];
    }
    return Promise.resolve(false);
  });
  render(TimelineListHarness, {
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

  expect(history).toHaveBeenCalledTimes(5);
});

test('a reset that leaves one message refills the viewport on its own', async () => {
  const roomTimeline = timeline();
  roomTimeline.items = Array.from({ length: 20 }, (_, index) => item(String(index)));
  const history = vi.fn(() => Promise.resolve(false));
  render(TimelineListHarness, {
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
    clientHeight: { configurable: true, value: 100 },
    scrollHeight: { configurable: true, value: 900 },
  });
  await tick();
  await runAnimationFrames();
  const opening = history.mock.calls.length;

  roomTimeline.items = [item('latest')];
  Object.defineProperty(element, 'scrollHeight', { configurable: true, value: 100 });
  await tick();
  await runAnimationFrames();

  expect(history.mock.calls.length).toBeGreaterThan(opening);
});

test('an empty snapshot keeps the skeleton until the first page decides', async () => {
  const roomTimeline = timeline();
  roomTimeline.items = [];
  let releaseHistory = (end: boolean): void => void end;
  const history = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        releaseHistory = resolve;
      })
  );
  render(TimelineListHarness, {
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

  expect(document.querySelector('.timeline-empty')).toBeNull();
  expect(document.querySelector('.timeline-placeholder')).not.toBeNull();
  expect(history).toHaveBeenCalled();

  releaseHistory(false);
  roomTimeline.items = [item('latest')];
  await runAnimationFrames();

  expect(document.querySelector('.timeline-empty')).toBeNull();
});

test('an empty room reports it once the start is reached', async () => {
  const roomTimeline = timeline();
  roomTimeline.items = [];
  const history = vi.fn(() => Promise.resolve(true));
  render(TimelineListHarness, {
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

  expect(document.querySelector('.timeline-empty')).not.toBeNull();
});

test("the timeline start renders the caller's notice in its row", async () => {
  const roomTimeline = timeline();
  roomTimeline.items = [
    { ...item('start'), event_id: null, content: { kind: 'timeline_start' } },
    item('first'),
  ];
  render(TimelineListHarness, {
    props: {
      list: {
        timeline: roomTimeline,
        onRequestHistory: () => Promise.resolve(true),
        onRequestFuture: async () => {},
        onRead: async () => {},
        timelineStart: createRawSnippet(() => ({
          render: () => '<p class="predecessor-stub">older room</p>',
        })),
      },
    },
  });

  viewport();
  await tick();
  await runAnimationFrames();

  const start = document.querySelector('[data-item-id="start"]');
  expect(start?.querySelector('.predecessor-stub')).not.toBeNull();
  expect(start?.querySelector('.separator')).toBeNull();
  expect(document.querySelectorAll('.predecessor-stub')).toHaveLength(1);
});

test('the timeline start keeps its separator without a notice', async () => {
  const roomTimeline = timeline();
  roomTimeline.items = [
    { ...item('start'), event_id: null, content: { kind: 'timeline_start' } },
    item('first'),
  ];
  render(TimelineListHarness, {
    props: {
      list: {
        timeline: roomTimeline,
        onRequestHistory: () => Promise.resolve(true),
        onRequestFuture: async () => {},
        onRead: async () => {},
      },
    },
  });

  viewport();
  await tick();
  await runAnimationFrames();

  expect(document.querySelector('[data-item-id="start"] .separator')).not.toBeNull();
});

test('a permalink that fails to load says so and offers the way back', async () => {
  const roomTimeline = timeline();
  roomTimeline.hasSnapshot = false;
  roomTimeline.mode = { kind: 'focused', eventId: '$missing' };
  roomTimeline.error = 'load_failed';
  const jumpToLive = vi.fn();
  render(TimelineListHarness, {
    props: {
      list: {
        timeline: roomTimeline,
        focusEventId: '$missing',
        onRequestHistory: () => Promise.resolve(true),
        onRequestFuture: async () => {},
        onRead: async () => {},
        onJumpToLive: jumpToLive,
      },
    },
  });

  viewport();
  await tick();
  await runAnimationFrames();

  const empty = document.querySelector<HTMLElement>('.timeline-empty');
  if (!empty) throw new Error('no empty state');
  expect(empty).toHaveTextContent('This message could not be loaded');
  expect(document.querySelector('.timeline-error')).not.toBeInTheDocument();
  await userEvent.click(within(empty).getByRole('button', { name: 'Jump to latest' }));
  expect(jumpToLive).toHaveBeenCalledOnce();
});

test('a live timeline that fails to load does not read as an empty room', async () => {
  const roomTimeline = timeline();
  roomTimeline.hasSnapshot = false;
  roomTimeline.error = 'load_failed';
  render(TimelineListHarness, {
    props: {
      list: {
        timeline: roomTimeline,
        onRequestHistory: () => Promise.resolve(true),
        onRequestFuture: async () => {},
        onRead: async () => {},
      },
    },
  });

  viewport();
  await tick();
  await runAnimationFrames();

  const empty = document.querySelector('.timeline-empty');
  expect(empty?.textContent).toContain('Unable to load messages');
  expect(document.querySelector('.timeline-error')).toBeNull();
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
  render(TimelineListHarness, {
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
  render(TimelineListHarness, {
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
});

test('a notification lands on its event in the live timeline, not on the unread marker', async () => {
  const jumps = vi.spyOn(TimelineWindow.prototype, 'jumpTo');
  const roomTimeline = timeline();
  roomTimeline.items = [readMarker('marker'), item('first'), item('notified'), item('latest')];
  const future = vi.fn(() => Promise.resolve());
  const landed = vi.fn();
  render(TimelineListHarness, {
    props: {
      list: {
        timeline: roomTimeline,
        landingEventId: '$notified',
        onLanded: landed,
        onRequestHistory: () => Promise.resolve(true),
        onRequestFuture: future,
        onRead: () => Promise.resolve(),
      },
    },
  });

  viewport();
  await tick();
  await runAnimationFrames();

  expect(jumps).toHaveBeenCalledWith(expect.stringContaining('notified'), 'center');
  expect(jumps).not.toHaveBeenCalledWith(expect.stringContaining('marker'), 'start');
  expect(document.querySelector('.message.highlighted')?.textContent).toContain('notified');
  expect(roomTimeline.mode.kind).toBe('live');
  expect(future).not.toHaveBeenCalled();
  expect(landed).toHaveBeenCalledTimes(1);
});

test('a notification lands on its event once it arrives after the room opened', async () => {
  const jumps = vi.spyOn(TimelineWindow.prototype, 'jumpTo');
  const landed = vi.fn();
  const roomTimeline = timeline();
  roomTimeline.items = [readMarker('marker'), item('latest')];
  render(TimelineListHarness, {
    props: {
      list: {
        timeline: roomTimeline,
        landingEventId: '$late',
        onLanded: landed,
        onRequestHistory: () => Promise.resolve(true),
        onRequestFuture: () => Promise.resolve(),
        onRead: () => Promise.resolve(),
      },
    },
  });

  viewport();
  await tick();
  await runAnimationFrames();
  expect(jumps).toHaveBeenCalledWith(expect.stringContaining('marker'), 'start');
  expect(landed).not.toHaveBeenCalled();

  roomTimeline.items = [...roomTimeline.items, item('late')];
  await tick();
  await runAnimationFrames();

  expect(jumps).toHaveBeenCalledWith(
    expect.stringContaining('late'),
    'center',
    expect.any(Boolean)
  );
  expect(landed).toHaveBeenCalledTimes(1);
  expect(document.querySelector('.message.highlighted')?.textContent).toContain('late');
});

test('a notification whose event arrives after the reader scrolled leaves them alone', async () => {
  const jumps = vi.spyOn(TimelineWindow.prototype, 'jumpTo');
  const landed = vi.fn();
  const roomTimeline = timeline();
  roomTimeline.items = [readMarker('marker'), item('latest')];
  render(TimelineListHarness, {
    props: {
      list: {
        timeline: roomTimeline,
        landingEventId: '$late',
        onLanded: landed,
        onRequestHistory: () => Promise.resolve(true),
        onRequestFuture: () => Promise.resolve(),
        onRead: () => Promise.resolve(),
      },
    },
  });

  const element = viewport();
  await tick();
  await runAnimationFrames();
  element.dispatchEvent(new WheelEvent('wheel', { deltaY: -50 }));
  expect(landed).toHaveBeenCalledTimes(1);

  roomTimeline.items = [...roomTimeline.items, item('late')];
  await tick();
  await runAnimationFrames();

  expect(jumps).not.toHaveBeenCalledWith(
    expect.stringContaining('late'),
    'center',
    expect.any(Boolean)
  );
  expect(document.querySelector('.message.highlighted')).toBeNull();
});

test('a notification whose event is not loaded falls back to the unread marker', async () => {
  const jumps = vi.spyOn(TimelineWindow.prototype, 'jumpTo');
  const roomTimeline = timeline();
  roomTimeline.items = [readMarker('marker'), item('latest')];
  render(TimelineListHarness, {
    props: {
      list: {
        timeline: roomTimeline,
        landingEventId: '$elsewhere',
        onRequestHistory: () => Promise.resolve(true),
        onRequestFuture: () => Promise.resolve(),
        onRead: () => Promise.resolve(),
      },
    },
  });

  viewport();
  await tick();
  await runAnimationFrames();

  expect(jumps).toHaveBeenCalledWith(expect.stringContaining('marker'), 'start');
});

test('does not eagerly paginate a scrollable initial timeline', async () => {
  const roomTimeline = timeline();
  roomTimeline.items = Array.from({ length: 20 }, (_, index) => item(String(index)));
  const history = vi.fn(() => Promise.resolve(false));
  render(TimelineListHarness, {
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
    scrollTop: { configurable: true, writable: true, value: 0 },
  });
  await tick();
  await runAnimationFrames();

  expect(history).not.toHaveBeenCalled();
});

test('does not read a viewport removed during initial positioning', async () => {
  const roomTimeline = timeline();
  roomTimeline.items = [item('latest')];
  const instance = render(TimelineListHarness, {
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
  instance.unmount();
  await runAnimationFrames();
});

test('leaves follow mode for a scroll it did not write, whatever produced it', async () => {
  const roomTimeline = timeline();
  roomTimeline.items = Array.from({ length: 20 }, (_, index) => item(String(index)));
  roomTimeline.backwardPagination = 'end';
  const history = vi.fn(() => Promise.resolve(false));
  render(TimelineListHarness, {
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

  element.scrollTop = 700;
  element.dispatchEvent(new Event('scroll'));
  await tick();

  expect(document.querySelector('.jump-to-latest')).not.toBeNull();
  expect(history).not.toHaveBeenCalled();
});

test('requests one history page until the viewport leaves the top threshold', async () => {
  const roomTimeline = timeline();
  roomTimeline.items = Array.from({ length: 20 }, (_, index) => item(String(index)));
  roomTimeline.mode = { kind: 'live' };
  const history = vi.fn(() => Promise.resolve(false));
  render(TimelineListHarness, {
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
  element.scrollTop = 20;
  element.dispatchEvent(new Event('scroll'));
  element.dispatchEvent(new WheelEvent('wheel', { deltaY: -200 }));
  element.dispatchEvent(new Event('scroll'));
  await finishWheelGesture(element);

  expect(history).toHaveBeenCalledTimes(1);
});

test('requests history from upward input when already at the top', async () => {
  const roomTimeline = timeline();
  roomTimeline.items = Array.from({ length: 20 }, (_, index) => item(String(index)));
  const history = vi.fn(() => Promise.resolve(false));
  render(TimelineListHarness, {
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
});

test('requests history before an upward wheel gesture settles', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const roomTimeline = timeline();
  roomTimeline.items = Array.from({ length: 20 }, (_, index) => item(String(index)));
  const history = vi.fn(() => Promise.resolve(false));
  render(TimelineListHarness, {
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
  element.dispatchEvent(new Event('scrollend'));
  await vi.advanceTimersByTimeAsync(160);
  await tick();
  expect(history).toHaveBeenCalledTimes(1);
});

test('a fresh upward input requests the next settled history page', async () => {
  const roomTimeline = timeline();
  roomTimeline.items = Array.from({ length: 20 }, (_, index) => item(String(index)));
  const history = vi.fn(() => Promise.resolve(false));
  render(TimelineListHarness, {
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
});

test('rate limits sparse history fill and continues until the server reports the end', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  try {
    const roomTimeline = timeline();
    roomTimeline.items = Array.from({ length: 20 }, (_, index) => item(String(index)));
    const history = vi.fn(() => Promise.resolve(history.mock.calls.length >= 25));
    const instance = render(TimelineListHarness, {
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
    await tick();
    await Promise.resolve();
    expect(history).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(299);
    expect(history).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(history).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(600);
    expect(history).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(TIMELINE_LAYOUT.historyRequestMinInterval * 30);
    expect(history).toHaveBeenCalledTimes(25);

    instance.unmount();
  } finally {
    vi.useRealTimers();
  }
});

test('cancels sparse history fill on downward input', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  try {
    const roomTimeline = timeline();
    roomTimeline.items = Array.from({ length: 20 }, (_, index) => item(String(index)));
    const history = vi.fn(() => Promise.resolve(false));
    const instance = render(TimelineListHarness, {
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
    await tick();
    element.dispatchEvent(new WheelEvent('wheel', { deltaY: 200 }));
    await vi.advanceTimersByTimeAsync(1_000);

    expect(history).toHaveBeenCalledTimes(1);
    instance.unmount();
  } finally {
    vi.useRealTimers();
  }
});

test('retries marking the latest event read after a failed request', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  const roomTimeline = timeline();
  roomTimeline.items = [item('latest')];
  roomTimeline.backwardPagination = 'end';
  const read = vi
    .fn<(_: string) => Promise<void>>()
    .mockRejectedValueOnce(new Error('temporary failure'))
    .mockResolvedValueOnce();
  const instance = render(TimelineListHarness, {
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
  instance.unmount();
  vi.useRealTimers();
});

const ROW = 100;

function layOutRows(): void {
  Object.defineProperty(HTMLElement.prototype, 'offsetHeight', { configurable: true, value: ROW });
}

interface LiveTimeline {
  instance: Record<string, unknown>;
  element: HTMLDivElement;
  end: number;
  setScrollHeight: (height: number) => void;
}

let currentLiveList: { followingLive: boolean };

/** Every row lays out at `ROW`, so the virtualiser and the stubbed box agree. */
async function mountLive(roomTimeline: RoomTimeline): Promise<LiveTimeline> {
  layOutRows();
  roomTimeline.mode = { kind: 'live' };
  roomTimeline.backwardPagination = 'end';
  const list = {
    timeline: roomTimeline,
    onRequestHistory: () => Promise.resolve(false),
    onRequestFuture: async () => {},
    onRead: async () => {},
    followingLive: false,
  };
  currentLiveList = list;
  const instance = render(TimelineListHarness, {
    props: { list },
  });
  let scrollHeight = roomTimeline.items.length * ROW;
  const element = viewport();
  Object.defineProperties(element, {
    scrollHeight: { configurable: true, get: () => scrollHeight },
    scrollTop: { configurable: true, writable: true, value: 0 },
  });
  await tick();
  await runAnimationFrames();
  element.dispatchEvent(new Event('scroll'));
  await tick();
  await runAnimationFrames();
  return {
    instance,
    element,
    end: element.scrollHeight - element.clientHeight,
    setScrollHeight: (next) => {
      scrollHeight = next;
    },
  };
}

test('scrolling reuses media width until the column resizes', async () => {
  const observers: { targets: Set<Element>; resize: () => void }[] = [];
  vi.stubGlobal(
    'ResizeObserver',
    class {
      targets = new Set<Element>();
      constructor(callback: ResizeObserverCallback) {
        observers.push({
          targets: this.targets,
          resize: () => {
            callback([], this);
          },
        });
      }
      observe(target: Element): void {
        this.targets.add(target);
      }
      unobserve(target: Element): void {
        this.targets.delete(target);
      }
      disconnect(): void {
        this.targets.clear();
      }
    }
  );
  const roomTimeline = timeline();
  roomTimeline.items = liveItems(100);
  const { element } = await mountLive(roomTimeline);
  vi.useFakeTimers();
  const main = element.querySelector<HTMLElement>('.message-main');
  if (!main) throw new Error('message column not found');
  const width = vi.fn(() => 280);
  Object.defineProperty(main, 'clientWidth', { configurable: true, get: width });
  const observer = observers.find(({ targets }) => targets.has(element) && targets.has(main));
  if (!observer) throw new Error('media width observer not found');
  observer.resize();
  expect(width).toHaveBeenCalledOnce();
  width.mockClear();

  for (let index = 0; index < 3; index++) {
    element.scrollTop -= 50;
    element.dispatchEvent(new Event('scroll'));
    await tick();
  }
  expect(width).not.toHaveBeenCalled();

  width.mockReturnValue(200);
  observer.resize();
  expect(width).toHaveBeenCalledOnce();
});

test('a backward pagination keeps its loading pill between pages, then fades it away', async () => {
  const roomTimeline = timeline();
  roomTimeline.items = liveItems(20);
  const { element } = await mountLive(roomTimeline);
  const beforeScroll = element.scrollTop;
  const beforeHeight = contentHeight();
  expect(document.querySelector('.history-loading')).toBeNull();

  roomTimeline.backwardPagination = 'loading';
  await tick();
  await runAnimationFrames();

  expect(document.querySelector('.history-loading')).not.toBeNull();
  expect(document.querySelector('.history-loading')?.textContent).toContain(
    'Loading older messages'
  );
  expect(contentHeight()).toBe(beforeHeight);
  expect(element.scrollTop).toBe(beforeScroll);

  roomTimeline.backwardPagination = 'idle';
  await tick();
  await runAnimationFrames();

  expect(document.querySelector('.history-loading')).not.toBeNull();
  expect(contentHeight()).toBe(beforeHeight);
  expect(element.scrollTop).toBe(beforeScroll);

  roomTimeline.backwardPagination = 'loading';
  await new Promise((resolve) => setTimeout(resolve, TIMELINE_LAYOUT.historyLoadingLinger));
  await tick();
  expect(document.querySelector('.history-loading')).not.toBeNull();

  roomTimeline.backwardPagination = 'idle';
  await new Promise((resolve) => setTimeout(resolve, TIMELINE_LAYOUT.historyLoadingLinger + 50));
  await tick();
  await runAnimationFrames();
  expect(document.querySelector('.history-loading')?.hasAttribute('inert')).toBe(true);
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

function followingLive(): boolean {
  return currentLiveList.followingLive;
}

function liveItems(count: number): TimelineItemView[] {
  return Array.from({ length: count }, (_, index) => item(String(index)));
}

test('reading back inside the near-latest band leaves follow mode', async () => {
  const roomTimeline = timeline();
  roomTimeline.items = liveItems(20);
  const { element, end } = await mountLive(roomTimeline);
  expect(document.querySelectorAll('.item').length).toBeGreaterThan(0);
  expect(followingLive()).toBe(true);

  await dragTo(element, end, end - 30);

  expect(followingLive()).toBe(false);
  expect(document.querySelector('.jump-to-latest')).toBeNull();
});

test('reading back past the band anchors', async () => {
  const roomTimeline = timeline();
  roomTimeline.items = liveItems(20);
  const { element, end } = await mountLive(roomTimeline);

  await dragTo(element, end, end - 900);

  expect(followingLive()).toBe(false);
  expect(document.querySelector('.jump-to-latest')).not.toBeNull();
});

test('shows the jump control once the reader is a page behind the latest message', async () => {
  const roomTimeline = timeline();
  roomTimeline.items = liveItems(20);
  const { element, end } = await mountLive(roomTimeline);

  await dragTo(element, end, end - element.clientHeight + 1);
  expect(followingLive()).toBe(false);
  expect(document.querySelector('.jump-to-latest')).toBeNull();

  await dragTo(element, end - element.clientHeight + 1, end - element.clientHeight);
  expect(followingLive()).toBe(false);
  expect(document.querySelector('.jump-to-latest')).not.toBeNull();

  await dragTo(element, end - element.clientHeight, end - element.clientHeight + 1);
  expect(document.querySelector('.jump-to-latest')).toBeNull();
});

test('follows an own echo appended while the reader is still near latest', async () => {
  const roomTimeline = timeline();
  roomTimeline.items = liveItems(20);
  const { element, end, setScrollHeight } = await mountLive(roomTimeline);

  await dragTo(element, end, end - 30);
  expect(followingLive()).toBe(false);

  touch(element, 'touchend', 170);
  await new Promise((resolve) => setTimeout(resolve, 160));
  await tick();

  const ownEcho = {
    ...item('own-echo'),
    event_id: null,
    transaction_id: 'txn-own-echo',
    is_own: true,
    send_state: { status: 'sending' as const, progress: null },
  };
  roomTimeline.items = [...roomTimeline.items, ownEcho];
  setScrollHeight(2_100);
  await tick();
  await runAnimationFrames();

  expect(document.querySelectorAll('.item')).toHaveLength(21);
  expect(element.scrollHeight - element.clientHeight - element.scrollTop).toBe(0);
  expect(followingLive()).toBe(true);
});

test('follows an own message sent in a thread while the reader is near latest', async () => {
  const roomTimeline = timeline();
  roomTimeline.items = liveItems(20);
  const { element, end, setScrollHeight } = await mountLive(roomTimeline);
  roomTimeline.mode = { kind: 'thread', rootEventId: '$root' };
  await tick();

  await dragTo(element, end, end - 30);
  touch(element, 'touchend', 170);
  await finishWheelGesture(element);

  roomTimeline.items = [...roomTimeline.items, { ...item('own-thread-message'), is_own: true }];
  setScrollHeight(2_100);
  await runAnimationFrames();

  expect(element.scrollHeight - element.clientHeight - element.scrollTop).toBe(0);
});

test('follows an own message that arrives already sent while the reader is near latest', async () => {
  const roomTimeline = timeline();
  roomTimeline.items = liveItems(20);
  const { element, end, setScrollHeight } = await mountLive(roomTimeline);

  await dragTo(element, end, end - 30);
  touch(element, 'touchend', 170);
  await new Promise((resolve) => setTimeout(resolve, 160));
  await tick();
  expect(followingLive()).toBe(false);

  roomTimeline.items = [
    ...roomTimeline.items,
    { ...item('own-sent'), event_id: '$own-sent', transaction_id: 'txn-own-sent', is_own: true },
  ];
  setScrollHeight(2_100);
  await tick();
  await runAnimationFrames();

  expect(element.scrollHeight - element.clientHeight - element.scrollTop).toBe(0);
  expect(followingLive()).toBe(true);
  expect(document.querySelector('.jump-to-latest')).toBeNull();
});

function focusComposer(): void {
  const composer = document.querySelector<HTMLTextAreaElement>('.harness-composer textarea');
  if (!composer) throw new Error('composer missing');
  composer.focus();
}

test('focusing the composer near latest follows the latest message', async () => {
  const roomTimeline = timeline();
  roomTimeline.items = liveItems(20);
  const { element, end } = await mountLive(roomTimeline);

  await dragTo(element, end, end - 30);
  touch(element, 'touchend', 170);
  await new Promise((resolve) => setTimeout(resolve, 160));
  await tick();
  expect(followingLive()).toBe(false);

  focusComposer();
  await tick();
  await runAnimationFrames();

  expect(element.scrollHeight - element.clientHeight - element.scrollTop).toBe(0);
  expect(followingLive()).toBe(true);
});

test('focusing the composer leaves a reader past the band where they are', async () => {
  const roomTimeline = timeline();
  roomTimeline.items = liveItems(20);
  const { element, end } = await mountLive(roomTimeline);

  await dragTo(element, end, end - 900);
  touch(element, 'touchend', 170);
  await new Promise((resolve) => setTimeout(resolve, 160));
  await tick();

  focusComposer();
  await tick();
  await runAnimationFrames();

  expect(element.scrollTop).toBe(end - 900);
  expect(followingLive()).toBe(false);
});

test('leaves a reader deep in history where they are when they send', async () => {
  const roomTimeline = timeline();
  roomTimeline.items = liveItems(20);
  const { element, end, setScrollHeight } = await mountLive(roomTimeline);

  await dragTo(element, end, end - 900);
  expect(followingLive()).toBe(false);

  touch(element, 'touchend', 170);
  await new Promise((resolve) => setTimeout(resolve, 160));
  await tick();

  roomTimeline.items = [
    ...roomTimeline.items,
    {
      ...item('own-echo'),
      event_id: null,
      transaction_id: 'txn-own-echo',
      is_own: true,
      send_state: { status: 'sending' as const, progress: null },
    },
  ];
  setScrollHeight(2_100);
  await tick();
  await runAnimationFrames();

  expect(followingLive()).toBe(false);
});

test('scrolling back to the end restores follow mode', async () => {
  const roomTimeline = timeline();
  roomTimeline.items = liveItems(20);
  const { element, end } = await mountLive(roomTimeline);

  await dragTo(element, end, end - 900);
  expect(followingLive()).toBe(false);

  await dragTo(element, end - 900, end);

  expect(followingLive()).toBe(true);
});

test('hides the jump control when a content shrink clamps an anchored reader to the end', async () => {
  const roomTimeline = timeline();
  roomTimeline.items = liveItems(20);
  const { element, end, setScrollHeight } = await mountLive(roomTimeline);

  await dragTo(element, end, end - 900);
  expect(followingLive()).toBe(false);

  setScrollHeight(1_000);
  element.scrollTop = element.scrollHeight - element.clientHeight;
  element.dispatchEvent(new Event('scroll'));
  await tick();

  expect(followingLive()).toBe(true);
});

function contentHeight(): number {
  const element = document.querySelector('.items');
  if (!(element instanceof HTMLElement)) throw new Error('timeline content not found');
  return Number.parseFloat(element.style.height);
}

test('a tab restore keeps the row heights it measured', async () => {
  const roomTimeline = timeline();
  roomTimeline.items = liveItems(20);
  await mountLive(roomTimeline);
  const measured = contentHeight();
  expect(measured).toBeGreaterThan(20 * ROW * 0.5);

  document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
  await runAnimationFrames();

  expect(contentHeight()).toBeGreaterThanOrEqual(measured);
});

test('a tab restore re-reads a rendered row whose measurement went stale', async () => {
  const roomTimeline = timeline();
  roomTimeline.items = liveItems(20);
  await mountLive(roomTimeline);
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
});

test('a wheel notch inside the band also leaves follow mode', async () => {
  const roomTimeline = timeline();
  roomTimeline.items = liveItems(20);
  const { element, end } = await mountLive(roomTimeline);

  element.dispatchEvent(new WheelEvent('wheel', { deltaY: -30 }));
  element.scrollTop = end - 30;
  element.dispatchEvent(new Event('scroll'));
  await tick();

  expect(followingLive()).toBe(false);
});

test('a repeated scroll notification near latest preserves the reading position', async () => {
  const roomTimeline = timeline();
  roomTimeline.items = liveItems(20);
  const { element, end } = await mountLive(roomTimeline);

  await dragTo(element, end, end - 30);
  expect(followingLive()).toBe(false);
  element.dispatchEvent(new Event('scroll'));
  await tick();

  expect(followingLive()).toBe(false);
});

test('middle-button autoscroll leaves follow mode', async () => {
  const roomTimeline = timeline();
  roomTimeline.items = liveItems(20);
  const { element, end } = await mountLive(roomTimeline);

  element.dispatchEvent(new PointerEvent('pointerdown', { button: 1 }));
  element.scrollTop = end - 900;
  element.dispatchEvent(new Event('scroll'));
  await tick();

  expect(followingLive()).toBe(false);
});

test('a scrollbar drag leaves follow mode like any other reading back', async () => {
  const roomTimeline = timeline();
  roomTimeline.items = liveItems(20);
  const { element, end } = await mountLive(roomTimeline);

  element.dispatchEvent(new PointerEvent('pointerdown', { button: 0 }));
  element.scrollTop = end - 900;
  element.dispatchEvent(new Event('scroll'));
  await tick();

  expect(followingLive()).toBe(false);
});

test('limits hidden opening refills', async () => {
  const roomTimeline = timeline();
  roomTimeline.items = [hiddenItem('renamed')];
  const history = vi.fn(() => Promise.resolve(history.mock.calls.length >= 25));
  render(TimelineListHarness, {
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
  for (let round = 0; round < 30; round += 1) {
    await runAnimationFrames();
  }

  expect(history).toHaveBeenCalledTimes(5);
});

test('a window of hidden events keeps the skeleton rather than the filtered notice', async () => {
  const roomTimeline = timeline();
  roomTimeline.items = [hiddenItem('renamed')];
  const history = vi.fn(() => Promise.resolve(false));
  render(TimelineListHarness, {
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

  expect(document.querySelector('.timeline-empty')).toBeNull();
  expect(document.querySelector('.timeline-placeholder')).not.toBeNull();

  roomTimeline.backwardPagination = 'end';
  await tick();
  await runAnimationFrames();

  expect(document.querySelector('.timeline-empty')).not.toBeNull();
});

test('waits out a page in flight when the room opens', async () => {
  const roomTimeline = timeline();
  roomTimeline.items = [item('latest')];
  roomTimeline.backwardPagination = 'loading';
  const history = vi.fn(() => Promise.resolve(false));
  render(TimelineListHarness, {
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
});

test('asks for history again when the timeline is cleared mid-session', async () => {
  const roomTimeline = timeline();
  roomTimeline.items = [item('latest')];
  const history = vi.fn(() => Promise.resolve(false));
  render(TimelineListHarness, {
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
});

test('a cleared timeline is not held back by the start it reached before', async () => {
  const roomTimeline = timeline();
  roomTimeline.items = [item('latest')];
  const history = vi.fn(() => Promise.resolve(true));
  render(TimelineListHarness, {
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
});

test('an empty timeline stops when its refill reports the timeline start', async () => {
  const roomTimeline = timeline();
  roomTimeline.items = [item('latest')];
  const history = vi.fn(() => Promise.resolve(true));
  render(TimelineListHarness, {
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

  expect(history).toHaveBeenCalledTimes(afterClear);
});

test('a failed history request does not pass for the timeline start', async () => {
  const roomTimeline = timeline();
  roomTimeline.items = [];
  const history = vi.fn(() =>
    history.mock.calls.length === 1 ? Promise.reject(new Error('offline')) : Promise.resolve(false)
  );
  render(TimelineListHarness, {
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
  expect(history).toHaveBeenCalledTimes(1);

  roomTimeline.backwardPagination = 'loading';
  await tick();
  roomTimeline.backwardPagination = 'idle';
  await tick();
  await runAnimationFrames();

  expect(history).toHaveBeenCalledTimes(2);
});

test('a reset during a held touch does not paint placeholders over the rendered rows', async () => {
  const roomTimeline = timeline();
  roomTimeline.items = Array.from({ length: 20 }, (_, index) => item(String(index)));
  render(TimelineListHarness, {
    props: {
      list: {
        timeline: roomTimeline,
        onRequestHistory: () => Promise.resolve(false),
        onRequestFuture: async () => {},
        onRead: async () => {},
      },
    },
  });

  const element = viewport();
  await tick();
  await runAnimationFrames();
  expect(document.querySelectorAll('.window-rows > .item').length).toBeGreaterThan(0);

  touch(element, 'touchstart', 10);
  element.scrollTop = 10;
  element.dispatchEvent(new Event('scroll'));
  roomTimeline.items = [];
  await tick();
  await runAnimationFrames();

  expect({
    placeholder: document.querySelector('.timeline-placeholder') !== null,
    rendered: document.querySelectorAll('.window-rows > .item').length > 0,
  }).not.toEqual({ placeholder: true, rendered: true });
});

test('a permalink offers a way back to the live timeline', async () => {
  const roomTimeline = timeline();
  roomTimeline.items = Array.from({ length: 20 }, (_, index) => item(String(index)));
  roomTimeline.mode = { kind: 'focused', eventId: '$5' };
  roomTimeline.forwardPagination = 'end';
  const jumpToLive = vi.fn();
  render(TimelineListHarness, {
    props: {
      list: {
        timeline: roomTimeline,
        focusEventId: '$5',
        onRequestHistory: () => Promise.resolve(true),
        onRequestFuture: async () => {},
        onRead: async () => {},
        onJumpToLive: jumpToLive,
      },
    },
  });

  viewport();
  await tick();
  await runAnimationFrames();

  const jump = screen.queryByRole('button', { name: 'Jump to latest' });
  expect(jump, 'a focused timeline has no other way back to the present').toBeInTheDocument();
  if (jump) await userEvent.click(jump);
  expect(jumpToLive).toHaveBeenCalled();
});

test('paginating forward out of a permalink reports that it is loading', async () => {
  const roomTimeline = timeline();
  roomTimeline.items = Array.from({ length: 20 }, (_, index) => item(String(index)));
  roomTimeline.mode = { kind: 'focused', eventId: '$5' };
  render(TimelineListHarness, {
    props: {
      list: {
        timeline: roomTimeline,
        focusEventId: '$5',
        onRequestHistory: () => Promise.resolve(true),
        onRequestFuture: async () => {},
        onRead: async () => {},
      },
    },
  });

  viewport();
  await tick();
  await runAnimationFrames();
  expect(document.querySelector('.future-loading')).toBeNull();

  roomTimeline.forwardPagination = 'loading';
  await tick();

  expect(document.querySelector('.future-loading')).not.toBeNull();
});

test.each(['success', 'failure'] as const)(
  'stops rendering the read marker when a visible receipt has %s',
  async (result) => {
    const roomTimeline = timeline();
    roomTimeline.items = Array.from({ length: 5 }, (_, index) => item(`old-${String(index)}`));
    const read = vi.fn(() =>
      result === 'success' ? Promise.resolve() : Promise.reject(new Error('receipt failed'))
    );
    render(TimelineListHarness, {
      props: {
        list: {
          timeline: roomTimeline,
          onRequestHistory: () => Promise.resolve(true),
          onRequestFuture: async () => {},
          onRead: read,
        },
      },
    });

    viewport();
    await tick();
    await runAnimationFrames();
    await vi.waitFor(() => {
      expect(read).toHaveBeenCalled();
    });

    roomTimeline.items = [...roomTimeline.items, readMarker('marker'), item('arrival')];
    await tick();
    await runAnimationFrames();

    expect(document.querySelector('.unread')).toBeNull();
    expect(document.querySelector('[data-item-id="arrival"]')).not.toBeNull();
  }
);

test('a reader at the latest message also reads the hidden events after it', async () => {
  setPreference('hideMembershipEvents', true);
  const roomTimeline = timeline();
  const join: TimelineItemView = {
    ...item('join'),
    content: {
      kind: 'membership',
      change: 'joined',
      user_id: '@bob:example.org',
      display_name: 'Bob',
      reason: null,
    },
  };
  roomTimeline.items = [
    ...Array.from({ length: 5 }, (_, index) => item(`old-${String(index)}`)),
    join,
  ];
  const read = vi.fn((_eventId: string) => Promise.resolve());
  render(TimelineListHarness, {
    props: {
      list: {
        timeline: roomTimeline,
        onRequestHistory: () => Promise.resolve(true),
        onRequestFuture: async () => {},
        onRead: read,
      },
    },
  });

  viewport();
  await tick();
  await runAnimationFrames();

  expect(document.querySelector('[data-item-id="join"]')).toBeNull();
  await vi.waitFor(() => {
    expect(read).toHaveBeenLastCalledWith('$join', true);
  });
  setPreference('hideMembershipEvents', false);
});

test('the read marker waits for the latest message or for the reader to leave', async () => {
  const roomTimeline = timeline();
  roomTimeline.items = [item('read'), ...Array.from({ length: 12 }, (_, i) => item(`new-${i}`))];
  const read = vi.fn((_eventId: string, _fullyRead: boolean) => Promise.resolve());
  const fullyRead = vi.fn();
  const { unmount } = render(TimelineListHarness, {
    props: {
      list: {
        timeline: roomTimeline,
        roomId: '!room:example.org',
        hasUnread: true,
        onLoadReadMarker: () => Promise.resolve('$read'),
        onRequestHistory: () => Promise.resolve(true),
        onRequestFuture: async () => {},
        onRead: read,
        onFullyRead: fullyRead,
      },
    },
  });
  unreadViewport();
  await tick();
  await runAnimationFrames();
  await vi.waitFor(() => {
    expect(read).toHaveBeenCalled();
  });
  const [eventId, latest] = read.mock.calls.at(-1) ?? [];
  expect(eventId).not.toBe('$new-11');
  expect(latest).toBe(false);
  expect(fullyRead).not.toHaveBeenCalled();

  unmount();
  expect(fullyRead).toHaveBeenCalledExactlyOnceWith('!room:example.org', eventId);
});

function unreadViewport(): HTMLDivElement {
  const element = viewport();
  Object.defineProperties(element, {
    scrollHeight: {
      configurable: true,
      get: () =>
        Number.parseFloat(document.querySelector<HTMLElement>('.items')?.style.height ?? '100'),
    },
    scrollTop: { configurable: true, writable: true, value: 0 },
  });
  return element;
}

test('an unloaded unread boundary stays visible until the reader requests it', async () => {
  const roomTimeline = timeline();
  roomTimeline.items = [item('later-1'), item('later-2'), item('later-3')];
  let resolveHistory!: (end: boolean) => void;
  const history = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        resolveHistory = resolve;
      })
  );
  const read = vi.fn().mockResolvedValue(undefined);
  const jumps = vi.spyOn(TimelineWindow.prototype, 'jumpTo');
  render(TimelineListHarness, {
    props: {
      list: {
        timeline: roomTimeline,
        hasUnread: true,
        onLoadReadMarker: () => Promise.resolve('$read'),
        onRequestHistory: history,
        onRequestFuture: async () => {},
        onRead: read,
      },
    },
  });
  unreadViewport();
  await tick();
  await runAnimationFrames();
  expect(history).not.toHaveBeenCalled();
  expect(timelineViewport()).not.toHaveClass('initial');
  expect(read).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole('button', { name: 'Jump to unread' }));
  expect(history).toHaveBeenCalledTimes(1);
  roomTimeline.items = [item('read'), item('first'), ...roomTimeline.items];
  resolveHistory(false);
  await tick();
  await runAnimationFrames();
  expect(timelineViewport()).not.toHaveClass('initial');
  expect(jumps).toHaveBeenCalledWith(
    expect.stringContaining('first'),
    'start',
    false,
    expect.any(AbortSignal)
  );
});

test('opening a large unread backlog reveals the room before an older page finishes', async () => {
  const roomTimeline = timeline();
  roomTimeline.items = Array.from({ length: 30 }, (_, index) => item(`recent-${index}`));
  const historyPage = Promise.withResolvers<boolean>();
  const history = vi.fn(() => historyPage.promise);
  render(TimelineListHarness, {
    props: {
      list: {
        timeline: roomTimeline,
        hasUnread: true,
        onLoadReadMarker: () => Promise.resolve('$old-marker'),
        onRequestHistory: history,
        onRequestFuture: () => Promise.resolve(),
        onRead: () => Promise.resolve(),
      },
    },
  });
  unreadViewport();
  await tick();
  await runAnimationFrames();
  expect(timelineViewport()).not.toHaveClass('initial');
  expect(history).not.toHaveBeenCalled();
  historyPage.resolve(false);
  await runAnimationFrames();
});

test('a slow marker lookup leaves messages visible and receipts blocked', async () => {
  const roomTimeline = timeline();
  roomTimeline.items = Array.from({ length: 30 }, (_, index) => item(`recent-${index}`));
  const marker = Promise.withResolvers<string | null>();
  const read = vi.fn().mockResolvedValue(undefined);
  render(TimelineListHarness, {
    props: {
      list: {
        timeline: roomTimeline,
        hasUnread: true,
        onLoadReadMarker: () => marker.promise,
        onRequestHistory: () => Promise.resolve(false),
        onRequestFuture: () => Promise.resolve(),
        onRead: read,
      },
    },
  });
  unreadViewport();
  await tick();
  await runAnimationFrames();
  expect(timelineViewport()).not.toHaveClass('initial');
  expect(read).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: 'Jump to unread' })).not.toBeInTheDocument();
  marker.resolve('$old-marker');
  await runAnimationFrames();
  expect(screen.getByRole('button', { name: 'Jump to unread' })).toBeInTheDocument();
});

test('jumping to an unloaded marker requests event context instead of scanning history', async () => {
  const roomTimeline = timeline();
  roomTimeline.items = Array.from({ length: 30 }, (_, index) => item(`recent-${index}`));
  const history = vi.fn().mockResolvedValue(false);
  const jump = vi.fn();
  render(TimelineListHarness, {
    props: {
      list: {
        timeline: roomTimeline,
        hasUnread: true,
        onLoadReadMarker: () => Promise.resolve('$old-marker'),
        onRequestHistory: history,
        onRequestFuture: () => Promise.resolve(),
        onRead: () => Promise.resolve(),
        onRequestUnread: jump.mockImplementation(() => {
          roomTimeline.mode = { kind: 'unread', eventId: '$old-marker' };
          roomTimeline.items = [item('old-marker'), item('first'), ...roomTimeline.items];
          return Promise.resolve();
        }),
      },
    },
  });
  unreadViewport();
  await tick();
  await runAnimationFrames();
  await userEvent.click(screen.getByRole('button', { name: 'Jump to unread' }));
  expect(jump).toHaveBeenCalledWith('$old-marker');
  expect(history).not.toHaveBeenCalled();
});

test('unread resumes live at forward end while the reader is above the bottom', async () => {
  const roomTimeline = timeline();
  roomTimeline.mode = { kind: 'unread', eventId: '$read' };
  roomTimeline.items = [
    item('read'),
    readMarker('marker'),
    ...Array.from({ length: 30 }, (_, index) => item(`message-${index}`)),
  ];
  const resume = vi.fn(() => {
    roomTimeline.mode = { kind: 'live' };
    return Promise.resolve();
  });
  render(TimelineListHarness, {
    props: {
      list: {
        timeline: roomTimeline,
        hasUnread: true,
        onRequestHistory: () => Promise.resolve(false),
        onRequestFuture: () => Promise.resolve(),
        onRead: () => Promise.resolve(),
        onResumeLive: resume,
      },
    },
  });
  const node = unreadViewport();
  await tick();
  await runAnimationFrames();
  expect(node.scrollTop).toBeLessThan(node.scrollHeight - node.clientHeight);
  expect(resume).not.toHaveBeenCalled();
  roomTimeline.forwardPagination = 'end';
  await tick();
  await runAnimationFrames();
  expect(resume).toHaveBeenCalledWith(expect.any(Function));
  expect(roomTimeline.mode.kind).toBe('live');
});

test('a failed return to live offers a translated retry', async () => {
  const roomTimeline = timeline();
  roomTimeline.mode = { kind: 'unread', eventId: '$read' };
  roomTimeline.forwardPagination = 'end';
  roomTimeline.items = [item('read'), readMarker('marker'), item('first')];
  const resume = vi
    .fn()
    .mockRejectedValueOnce(new Error('offline'))
    .mockImplementationOnce(() => {
      roomTimeline.mode = { kind: 'live' };
      return Promise.resolve();
    });
  render(TimelineListHarness, {
    props: {
      list: {
        timeline: roomTimeline,
        hasUnread: true,
        onRequestHistory: () => Promise.resolve(false),
        onRequestFuture: () => Promise.resolve(),
        onRead: () => Promise.resolve(),
        onResumeLive: resume,
      },
    },
  });
  unreadViewport();
  await tick();
  await runAnimationFrames();
  const retry = await screen.findByRole('button', { name: 'Try again' });
  await userEvent.click(retry);
  await tick();
  expect(resume).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
});

test('a notification below unread keeps the bar and blocks receipts until jumping back', async () => {
  const roomTimeline = timeline();
  roomTimeline.items = [
    item('read'),
    readMarker('marker'),
    ...Array.from({ length: 12 }, (_, i) => item(`new-${i}`)),
  ];
  const read = vi.fn().mockResolvedValue(undefined);
  render(TimelineListHarness, {
    props: {
      list: {
        timeline: roomTimeline,
        landingEventId: '$new-10',
        onRequestHistory: () => Promise.resolve(true),
        onRequestFuture: async () => {},
        onRead: read,
      },
    },
  });
  unreadViewport();
  await tick();
  await runAnimationFrames();
  await new Promise((resolve) => setTimeout(resolve, 550));
  expect(read).not.toHaveBeenCalled();
  const jump = screen.getByRole('button', { name: 'Jump to unread' });
  expect(jump).toHaveTextContent('12 new messages');
  const jumps = vi.spyOn(TimelineWindow.prototype, 'jumpTo');
  await userEvent.click(jump);
  await runAnimationFrames();
  expect(jumps).toHaveBeenCalledWith(
    expect.stringContaining('new-0'),
    'start',
    false,
    expect.any(AbortSignal)
  );
  expect(screen.queryByRole('button', { name: 'Jump to unread' })).not.toBeInTheDocument();
  await vi.waitFor(() => {
    expect(read).toHaveBeenCalled();
  });
});

test('an unread context without an SDK marker lands before returning to live', async () => {
  const roomTimeline = timeline();
  roomTimeline.mode = { kind: 'unread', eventId: '$read' };
  roomTimeline.readMarkerEventId = '$read';
  roomTimeline.forwardPagination = 'end';
  roomTimeline.items = [item('read'), ...Array.from({ length: 12 }, (_, i) => item(`new-${i}`))];
  const order: string[] = [];
  vi.spyOn(TimelineWindow.prototype, 'jumpTo').mockImplementation((key) => {
    order.push(`jump:${String(key)}`);
    return Promise.resolve(true);
  });
  const resume = vi.fn(() => {
    order.push('resume');
    return new Promise<void>(() => {});
  });
  render(TimelineListHarness, {
    props: {
      list: {
        timeline: roomTimeline,
        hasUnread: true,
        onLoadReadMarker: () => new Promise<string | null>(() => {}),
        onRequestHistory: () => Promise.resolve(false),
        onRequestFuture: () => Promise.resolve(),
        onRead: () => Promise.resolve(),
        onResumeLive: resume,
      },
    },
  });
  unreadViewport();
  await tick();
  await runAnimationFrames();
  expect(order[0]).toBe('jump:item:unread-marker');
  expect(order).toContain('resume');
});

test('the unread marker stays where the room opened while receipts move the read marker', async () => {
  const roomTimeline = timeline();
  const unread = Array.from({ length: 12 }, (_, i) => item(`new-${i}`));
  roomTimeline.items = [item('read'), readMarker('marker'), ...unread];
  render(TimelineListHarness, {
    props: {
      list: {
        timeline: roomTimeline,
        hasUnread: true,
        onRequestHistory: () => Promise.resolve(true),
        onRequestFuture: async () => {},
        onRead: async () => {},
      },
    },
  });
  unreadViewport();
  await tick();
  await runAnimationFrames();
  const markerFollows = (): string | null | undefined =>
    document
      .querySelector('.unread')
      ?.closest('[data-item-id]')
      ?.nextElementSibling?.getAttribute('data-item-id');
  expect(markerFollows()).toBe('new-0');

  roomTimeline.items = [
    item('read'),
    ...unread.slice(0, 6),
    readMarker('moved'),
    ...unread.slice(6),
  ];
  await tick();
  await runAnimationFrames();
  expect(document.querySelectorAll('.unread')).toHaveLength(1);
  expect(markerFollows()).toBe('new-0');

  roomTimeline.items = [item('read'), ...unread];
  await tick();
  await runAnimationFrames();
  expect(markerFollows()).toBe('new-0');
});

test('marking the unread bar as read keeps it on failure and clears it on success', async () => {
  const roomTimeline = timeline();
  roomTimeline.items = [
    readMarker('marker'),
    ...Array.from({ length: 12 }, (_, i) => item(`new-${i}`)),
  ];
  const mark = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue(undefined);
  render(TimelineListHarness, {
    props: {
      list: {
        timeline: roomTimeline,
        landingEventId: '$new-10',
        onRequestHistory: () => Promise.resolve(true),
        onRequestFuture: async () => {},
        onRead: async () => {},
        onMarkRead: mark,
      },
    },
  });
  unreadViewport();
  await tick();
  await runAnimationFrames();
  await userEvent.click(screen.getByRole('button', { name: 'Mark as read' }));
  expect(screen.getByRole('alert')).toHaveTextContent('Could not mark this room as read');
  expect(screen.getByRole('button', { name: 'Jump to unread' })).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Mark as read' }));
  await tick();
  expect(screen.queryByRole('button', { name: 'Jump to unread' })).not.toBeInTheDocument();
});

test('Escape jumps to the latest message and marks the room read', async () => {
  const roomTimeline = timeline();
  roomTimeline.items = [
    readMarker('marker'),
    ...Array.from({ length: 12 }, (_, i) => item(`new-${i}`)),
  ];
  const mark = vi.fn().mockResolvedValue(undefined);
  const jumps = vi.spyOn(TimelineWindow.prototype, 'jumpTo');
  render(TimelineListHarness, {
    props: {
      list: {
        timeline: roomTimeline,
        landingEventId: '$new-10',
        onRequestHistory: () => Promise.resolve(true),
        onRequestFuture: async () => {},
        onRead: async () => {},
        onMarkRead: mark,
      },
    },
  });
  unreadViewport();
  await tick();
  await runAnimationFrames();
  jumps.mockClear();
  await userEvent.keyboard('{Escape}');
  await tick();
  expect(jumps).toHaveBeenCalledWith(null, 'start', expect.anything());
  expect(mark).toHaveBeenCalledOnce();
});

test('an unread search with no history progress is bounded and can be retried', async () => {
  const roomTimeline = timeline();
  roomTimeline.items = [item('later-1'), item('later-2'), item('later-3')];
  const history = vi.fn(() => Promise.resolve(false));
  const read = vi.fn().mockResolvedValue(undefined);
  render(TimelineListHarness, {
    props: {
      list: {
        timeline: roomTimeline,
        hasUnread: true,
        onLoadReadMarker: () => Promise.resolve('$read'),
        onRequestHistory: history,
        onRequestFuture: async () => {},
        onRead: read,
      },
    },
  });
  unreadViewport();
  await tick();
  await runAnimationFrames();
  await runAnimationFrames();
  await runAnimationFrames();
  expect(timelineViewport()).not.toHaveClass('initial');
  expect(history).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole('button', { name: 'Jump to unread' }));
  await runAnimationFrames();
  await runAnimationFrames();
  expect(screen.getByRole('alert')).toHaveTextContent('Could not load unread messages');
  expect(history).toHaveBeenCalledTimes(5);
  expect(read).not.toHaveBeenCalled();
  history.mockImplementation(() => {
    roomTimeline.items = [item('read'), item('first'), ...roomTimeline.items];
    return Promise.resolve(false);
  });
  await userEvent.click(screen.getByRole('button', { name: 'Jump to unread' }));
  await runAnimationFrames();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(history).toHaveBeenCalledTimes(6);
});

test('changing timeline mode cancels an unread jump waiting for history', async () => {
  const roomTimeline = timeline();
  roomTimeline.items = Array.from({ length: 12 }, (_, index) => item(`later-${index}`));
  let resolveHistory!: (end: boolean) => void;
  const history = vi.fn(
    () =>
      new Promise<boolean>((resolve) => {
        resolveHistory = resolve;
      })
  );
  const jumps = vi.spyOn(TimelineWindow.prototype, 'jumpTo');
  render(TimelineListHarness, {
    props: {
      list: {
        timeline: roomTimeline,
        hasUnread: true,
        landingEventId: '$later-10',
        onLoadReadMarker: () => Promise.resolve('$read'),
        onRequestHistory: history,
        onRequestFuture: async () => {},
        onRead: async () => {},
      },
    },
  });
  unreadViewport();
  await tick();
  await runAnimationFrames();
  expect(history).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole('button', { name: 'Jump to unread' }));
  expect(history).toHaveBeenCalledTimes(1);
  roomTimeline.mode = { kind: 'focused', eventId: '$later-10' };
  await tick();
  roomTimeline.items = [item('read'), item('first'), ...roomTimeline.items];
  resolveHistory(false);
  await runAnimationFrames();
  expect(jumps.mock.calls.some(([key]) => key?.includes('first'))).toBe(false);
});

test('a notification at the snapshot edge loads newer pages without needing another scroll', async () => {
  const roomTimeline = timeline();
  roomTimeline.mode = { kind: 'focused', eventId: '$notification' };
  roomTimeline.items = [item('older'), item('notification')];
  const future = vi.fn(() => {
    roomTimeline.items = [...roomTimeline.items, item(`newer-${future.mock.calls.length}`)];
    if (future.mock.calls.length === 2) roomTimeline.forwardPagination = 'end';
    return Promise.resolve();
  });
  render(TimelineListHarness, {
    props: {
      list: {
        timeline: roomTimeline,
        focusEventId: '$notification',
        onRequestHistory: () => Promise.resolve(true),
        onRequestFuture: future,
        onRead: async () => {},
      },
    },
  });
  unreadViewport();
  await tick();
  await runAnimationFrames();
  expect(future).toHaveBeenCalledTimes(2);
  expect(document.querySelector('[data-item-id="newer-2"]')).not.toBeNull();
});

test('switching into a notification snapshot preserves the timeline attachment during opening', async () => {
  const roomTimeline = timeline();
  roomTimeline.loading = true;
  roomTimeline.hasSnapshot = false;
  const future = vi.fn(() => {
    roomTimeline.forwardPagination = 'end';
    return Promise.resolve();
  });
  render(TimelineListHarness, {
    props: {
      list: {
        timeline: roomTimeline,
        focusEventId: '$notification',
        onRequestHistory: () => Promise.resolve(true),
        onRequestFuture: future,
        onRead: async () => {},
      },
    },
  });
  unreadViewport();
  await tick();
  await runAnimationFrames();
  roomTimeline.mode = { kind: 'focused', eventId: '$notification' };
  roomTimeline.items = [item('older'), item('notification')];
  roomTimeline.loading = false;
  roomTimeline.hasSnapshot = true;
  await tick();
  await runAnimationFrames();
  expect(document.querySelector('.timeline-viewport')?.classList.contains('initial')).toBe(false);
  expect(future).toHaveBeenCalledTimes(1);
});

test.each(['wheel', 'touch', 'keyboard'] as const)(
  'a failed newer page can be retried with %s while already at the snapshot edge',
  async (input) => {
    const roomTimeline = timeline();
    roomTimeline.mode = { kind: 'focused', eventId: '$notification' };
    roomTimeline.items = [item('older'), item('notification')];
    const future = vi.fn(() => {
      if (future.mock.calls.length === 1) {
        roomTimeline.error = 'load_failed';
        throw new Error('offline');
      }
      roomTimeline.error = null;
      roomTimeline.items = [...roomTimeline.items, item('newer')];
      roomTimeline.forwardPagination = 'end';
      return Promise.resolve();
    });
    render(TimelineListHarness, {
      props: {
        list: {
          timeline: roomTimeline,
          focusEventId: '$notification',
          onRequestHistory: () => Promise.resolve(true),
          onRequestFuture: future,
          onRead: async () => {},
        },
      },
    });
    const node = unreadViewport();
    await tick();
    await runAnimationFrames();
    expect(future).toHaveBeenCalledTimes(1);
    const top = node.scrollTop;
    if (input === 'wheel') node.dispatchEvent(new WheelEvent('wheel', { deltaY: 200 }));
    else if (input === 'touch') touch(node, 'touchstart', 10);
    else node.dispatchEvent(new KeyboardEvent('keydown', { key: 'PageDown' }));
    expect(node.scrollTop).toBe(top);
    await runAnimationFrames();
    expect(future).toHaveBeenCalledTimes(2);
    if (input === 'touch') node.dispatchEvent(new TouchEvent('touchend', { touches: [] }));
    await finishWheelGesture(node);
    await runAnimationFrames();
    expect(document.querySelector('[data-item-id="newer"]')).not.toBeNull();
  }
);

test('empty newer pages can resume on a wheel gesture without needing scroll movement', async () => {
  const roomTimeline = timeline();
  roomTimeline.mode = { kind: 'focused', eventId: '$notification' };
  roomTimeline.items = [item('older'), item('notification')];
  const future = vi.fn(() => {
    if (future.mock.calls.length > MAX_EMPTY_REFILLS) {
      roomTimeline.items = [...roomTimeline.items, item('newer')];
      roomTimeline.forwardPagination = 'end';
    }
    return Promise.resolve();
  });
  render(TimelineListHarness, {
    props: {
      list: {
        timeline: roomTimeline,
        focusEventId: '$notification',
        onRequestHistory: () => Promise.resolve(true),
        onRequestFuture: future,
        onRead: async () => {},
      },
    },
  });
  const node = unreadViewport();
  await tick();
  await runAnimationFrames();
  expect(future).toHaveBeenCalledTimes(MAX_EMPTY_REFILLS);
  const top = node.scrollTop;
  node.dispatchEvent(new WheelEvent('wheel', { deltaY: 200 }));
  expect(node.scrollTop).toBe(top);
  await runAnimationFrames();
  expect(future).toHaveBeenCalledTimes(MAX_EMPTY_REFILLS + 1);
  await finishWheelGesture(node);
  await runAnimationFrames();
  expect(document.querySelector('[data-item-id="newer"]')).not.toBeNull();
});
