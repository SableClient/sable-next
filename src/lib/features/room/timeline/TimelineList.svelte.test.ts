// @vitest-environment happy-dom

import type { ResolvedItem } from '#lib/rooms/timeline-item.js';
import { render, screen, within } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { createRawSnippet } from 'svelte';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { flushed } from '#lib/ui/flushed.js';

import { NO_UNREAD, RoomTimeline } from '#lib/rooms/timeline.svelte.js';
import { groupRow, rowsOf, staticTimelineOf } from '#lib/test-support/static-timeline.svelte.js';

import { TimelineWindow } from '#lib/timeline/timeline-window.js';
import { setPreference } from '#lib/settings/preferences.svelte.js';
import { TIMELINE_LAYOUT } from './timeline-layout';
import { MAX_EMPTY_REFILLS } from './timeline-pagination.svelte.js';

vi.mock('$app/state', () => import('#lib/test-support/app-state.js'));
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
import { page, resetPage } from '#lib/test-support/app-state.js';
import { withRowFields } from '#lib/features/room/timeline/row-fixtures.js';

let animationFrames: FrameRequestCallback[];

beforeEach(() => {
  resetPage();
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
  setPreference('openRoomsAtUnread', true);
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  Reflect.deleteProperty(HTMLElement.prototype, 'offsetHeight');
});

const StaticTimeline = staticTimelineOf(RoomTimeline, NO_UNREAD);

function timeline(): InstanceType<typeof StaticTimeline> {
  return new StaticTimeline();
}

async function finishWheelGesture(element?: HTMLElement): Promise<void> {
  element?.dispatchEvent(new Event('scrollend'));
  await new Promise((resolve) => setTimeout(resolve, 160));
  await flushed();
}

function item(id: string): ResolvedItem {
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

function readMarker(id: string): ResolvedItem {
  return withRowFields({ ...item(id), event_id: null, content: { kind: 'read_marker' } });
}

function hiddenItem(id: string): ResolvedItem {
  return withRowFields({
    ...item(id),
    content: {
      kind: 'profile_change',
      user_id: '@alice:example.org',
      display_name: { old: 'Alice', new: id },
      avatar: null,
    },
  });
}

async function runAnimationFrames(): Promise<void> {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve();
    for (const callback of animationFrames.splice(0)) callback(0);
    await flushed();
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
  const eventSource = vi.fn(() => Promise.resolve({ source, encrypted: false, original: null }));
  Object.assign(core.rpc.timeline, { eventSource });
  const members = ['first', 'last'].map((id): ResolvedItem =>
    withRowFields({
      ...item(id),
      content: {
        kind: 'membership',
        change: 'joined',
        user_id: '@alice:example.org',
        display_name: 'Alice',
        reason: null,
      },
    })
  );
  roomTimeline.patch({ items: members, rows: [groupRow(members)] });
  roomTimeline.patch({ backwardPagination: 'end' });
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
  expect(eventSource).toHaveBeenCalledWith({
    room_id: '!room:example.org',
    event_id: '$first',
    include_original: true,
  });
  expect(screen.getByRole('dialog', { name: 'Message source' })).toHaveTextContent(source);
});

test('fills a short live timeline until the server reports the timeline start', async () => {
  const roomTimeline = timeline();
  roomTimeline.patch({ items: [item('latest')] });
  const history = vi.fn(() => {
    roomTimeline.patch({
      items: [hiddenItem(`older-${String(history.mock.calls.length)}`), ...roomTimeline.items],
    });
    return Promise.resolve(history.mock.calls.length >= 3);
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
  await flushed();
  await runAnimationFrames();

  expect(history).toHaveBeenCalledTimes(3);
});

test('announces new arrivals separately from virtualized history', async () => {
  const roomTimeline = timeline();
  roomTimeline.patch({ items: [item('initial')] });
  roomTimeline.patch({ backwardPagination: 'end' });
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
  roomTimeline.patch({ items: [item('history'), ...roomTimeline.items] });
  await runAnimationFrames();
  expect(announcement()).toBe('');
  roomTimeline.patch({ items: [...roomTimeline.items, item('new')] });
  await runAnimationFrames();
  expect(announcement()).toBe('1 new message');
  roomTimeline.patch({ items: [...roomTimeline.items, { ...item('own'), is_own: true }] });
  await runAnimationFrames();
  expect(announcement()).toBe('1 new message');
});

test('a permalink whose context does not fill the viewport paginates on its own', async () => {
  const roomTimeline = timeline();
  roomTimeline.patch({ items: [item('older'), item('target'), item('newer')] });
  roomTimeline.patch({ mode: { kind: 'focused', event_id: '$target' } });
  const future = vi.fn(() => {
    roomTimeline.patch({ forwardPagination: 'end' });
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
  await flushed();
  await runAnimationFrames();

  expect(future).toHaveBeenCalled();
});

test('a permalink that reached the newest messages keeps loading older ones', async () => {
  const roomTimeline = timeline();
  roomTimeline.patch({ items: [item('target')] });
  roomTimeline.patch({ mode: { kind: 'focused', event_id: '$target' } });
  roomTimeline.patch({ forwardPagination: 'end' });
  const history = vi.fn(() => Promise.resolve(false));
  render(TimelineListHarness, {
    props: {
      list: {
        timeline: roomTimeline,
        focusEventId: '$target',
        onRequestHistory: history,
        onRequestFuture: async () => {},
        onRead: async () => {},
      },
    },
  });

  viewport();
  await flushed();
  await runAnimationFrames();

  expect(history).toHaveBeenCalled();
});

test('own historical messages added to a permalink do not jump to the end', async () => {
  const roomTimeline = timeline();
  roomTimeline.patch({ items: [item('target')] });
  roomTimeline.patch({ mode: { kind: 'focused', event_id: '$target' } });
  roomTimeline.patch({ forwardPagination: 'end' });
  roomTimeline.patch({ backwardPagination: 'end' });
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

  roomTimeline.patch({ items: [...roomTimeline.items, { ...item('own-history'), is_own: true }] });
  await runAnimationFrames();

  expect(jumps).not.toHaveBeenCalledWith(null, 'start');
});

test('focused automatic pagination waits for new items after an empty page', async () => {
  const roomTimeline = timeline();
  roomTimeline.patch({ items: [item('target')] });
  roomTimeline.patch({ mode: { kind: 'focused', event_id: '$target' } });
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
  expect(future).toHaveBeenCalledTimes(1);
});

test('does not keep retrying a focused page when the timeline reports a load error', async () => {
  const roomTimeline = timeline();
  roomTimeline.patch({ items: [item('target')] });
  roomTimeline.patch({ mode: { kind: 'focused', event_id: '$target' } });
  const future = vi.fn(() => {
    roomTimeline.patch({ error: 'load_failed' });
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
    roomTimeline.patch({ items: [item('older'), item('target'), item('newer')] });
    roomTimeline.patch({ mode: { kind: 'focused', event_id: '$target' } });
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

test('an empty opening page stops after a few attempts until new items arrive', async () => {
  const roomTimeline = timeline();
  roomTimeline.patch({ items: [item('latest')] });
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
  await flushed();
  for (let page = 0; page < 30; page += 1) {
    await runAnimationFrames();
  }

  expect(history).toHaveBeenCalledTimes(MAX_EMPTY_REFILLS);
});

test('keeps filling past pages that only bring hidden events', async () => {
  const roomTimeline = timeline();
  roomTimeline.patch({ items: [item('latest')] });
  const history = vi.fn(() => {
    roomTimeline.patch({
      items: [hiddenItem(`hidden-${String(history.mock.calls.length)}`), ...roomTimeline.items],
    });
    return Promise.resolve(history.mock.calls.length >= 5);
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
  await flushed();
  await runAnimationFrames();
  await runAnimationFrames();

  expect(history).toHaveBeenCalledTimes(5);
});

test('the opening fill asks for larger pages after the first one', async () => {
  const roomTimeline = timeline();
  roomTimeline.patch({ items: [item('latest')] });
  const history = vi.fn((_count?: number) => {
    if (history.mock.calls.length === 3) {
      roomTimeline.patch({ items: [item('older'), ...roomTimeline.items] });
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
  await flushed();
  await runAnimationFrames();
  await runAnimationFrames();

  expect(history.mock.calls.map(([count]) => count)).toEqual([undefined, 100, 100]);
});

test('a reset that leaves one message refills the viewport on its own', async () => {
  const roomTimeline = timeline();
  roomTimeline.patch({ items: Array.from({ length: 20 }, (_, index) => item(String(index))) });
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
  await flushed();
  await runAnimationFrames();
  const opening = history.mock.calls.length;

  roomTimeline.patch({ items: [item('latest')] });
  Object.defineProperty(element, 'scrollHeight', { configurable: true, value: 100 });
  await flushed();
  await runAnimationFrames();

  expect(history.mock.calls.length).toBeGreaterThan(opening);
});

test('an empty snapshot keeps the skeleton until the first page decides', async () => {
  const roomTimeline = timeline();
  roomTimeline.patch({ items: [] });
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
  await flushed();
  await runAnimationFrames();

  expect(document.querySelector('.timeline-empty')).toBeNull();
  expect(document.querySelector('.timeline-placeholder')).not.toBeNull();
  expect(history).toHaveBeenCalled();

  releaseHistory(false);
  roomTimeline.patch({ items: [item('latest')] });
  await runAnimationFrames();

  expect(document.querySelector('.timeline-empty')).toBeNull();
});

test('an empty room reports it once the start is reached', async () => {
  const roomTimeline = timeline();
  roomTimeline.patch({ items: [] });
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
  await flushed();
  await runAnimationFrames();

  expect(document.querySelector('.timeline-empty')).not.toBeNull();
});

test("the timeline start renders the caller's notice in its row", async () => {
  const roomTimeline = timeline();
  roomTimeline.patch({
    items: [
      withRowFields({ ...item('start'), event_id: null, content: { kind: 'timeline_start' } }),
      item('first'),
    ],
  });
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
  await flushed();
  await runAnimationFrames();

  const start = document.querySelector('[data-item-id="start"]');
  expect(start?.querySelector('.predecessor-stub')).not.toBeNull();
  expect(start?.querySelector('.separator')).toBeNull();
  expect(document.querySelectorAll('.predecessor-stub')).toHaveLength(1);
});

test('the timeline start keeps its separator without a notice', async () => {
  const roomTimeline = timeline();
  roomTimeline.patch({
    items: [
      withRowFields({ ...item('start'), event_id: null, content: { kind: 'timeline_start' } }),
      item('first'),
    ],
  });
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
  await flushed();
  await runAnimationFrames();

  expect(document.querySelector('[data-item-id="start"] .separator')).not.toBeNull();
});

test('a permalink that fails to load says so and offers the way back', async () => {
  const roomTimeline = timeline();
  roomTimeline.patch({ hasSnapshot: false });
  roomTimeline.patch({ mode: { kind: 'focused', event_id: '$missing' } });
  roomTimeline.patch({ error: 'load_failed' });
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
  await flushed();
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
  roomTimeline.patch({ hasSnapshot: false });
  roomTimeline.patch({ error: 'load_failed' });
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
  await flushed();
  await runAnimationFrames();

  const empty = document.querySelector('.timeline-empty');
  expect(empty?.textContent).toContain('Unable to load messages');
  expect(document.querySelector('.timeline-error')).toBeNull();
});

test('reveals a short timeline at once and pads it out behind the reader', async () => {
  const roomTimeline = timeline();
  roomTimeline.patch({ items: [item('latest')] });
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
  await flushed();
  await runAnimationFrames();

  // Nothing to land on, so the reader sees the latest message while the fill runs.
  expect(timelineViewport().classList.contains('initial')).toBe(false);
  expect(history).toHaveBeenCalledTimes(1);

  releaseHistory();
  await runAnimationFrames();

  expect(timelineViewport().classList.contains('initial')).toBe(false);
});

test('a timeline with an unread marker reveals on it without waiting for history', async () => {
  const roomTimeline = timeline();
  roomTimeline.patch({ items: [readMarker('marker'), item('latest')] });
  const history = vi.fn(() => new Promise<boolean>(() => {}));
  const jumps = vi.spyOn(TimelineWindow.prototype, 'jumpTo');
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
  await flushed();
  await runAnimationFrames();

  expect(timelineViewport().classList.contains('initial')).toBe(false);
  expect(jumps.mock.calls.some(([key]) => key?.includes('marker'))).toBe(true);
});

test('a notification lands on its event in the live timeline, not on the unread marker', async () => {
  const jumps = vi.spyOn(TimelineWindow.prototype, 'jumpTo');
  const roomTimeline = timeline();
  roomTimeline.patch({
    items: [readMarker('marker'), item('first'), item('notified'), item('latest')],
  });
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
  await flushed();
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
  roomTimeline.patch({ items: [readMarker('marker'), item('latest')] });
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
  await flushed();
  await runAnimationFrames();
  expect(jumps).toHaveBeenCalledWith(expect.stringContaining('marker'), 'start');
  expect(landed).not.toHaveBeenCalled();

  roomTimeline.patch({ items: [...roomTimeline.items, item('late')] });
  await flushed();
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
  roomTimeline.patch({ items: [readMarker('marker'), item('latest')] });
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
  await flushed();
  await runAnimationFrames();
  element.dispatchEvent(new WheelEvent('wheel', { deltaY: -50 }));
  expect(landed).toHaveBeenCalledTimes(1);

  roomTimeline.patch({ items: [...roomTimeline.items, item('late')] });
  await flushed();
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
  roomTimeline.patch({ items: [readMarker('marker'), item('latest')] });
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
  await flushed();
  await runAnimationFrames();

  expect(jumps).toHaveBeenCalledWith(expect.stringContaining('marker'), 'start');
});

test('a notification whose event is not loaded opens its context and lands on it', async () => {
  const jumps = vi.spyOn(TimelineWindow.prototype, 'jumpTo');
  const landed = vi.fn();
  const read = vi.fn().mockResolvedValue(undefined);
  const roomTimeline = timeline();
  roomTimeline.patch({ items: [readMarker('marker'), item('latest')] });
  const requestUnread = vi.fn((eventId: string) => {
    roomTimeline.patch({ mode: { kind: 'unread', event_id: eventId } });
    roomTimeline.patch({ items: [item('before'), item('elsewhere'), item('after')] });
    return Promise.resolve();
  });
  render(TimelineListHarness, {
    props: {
      list: {
        timeline: roomTimeline,
        landingEventId: '$elsewhere',
        onLanded: landed,
        onRequestUnread: requestUnread,
        onRequestHistory: () => Promise.resolve(true),
        onRequestFuture: () => Promise.resolve(),
        onRead: read,
      },
    },
  });

  viewport();
  await flushed();
  await runAnimationFrames();

  expect(requestUnread).toHaveBeenCalledWith('$elsewhere');
  expect(jumps).not.toHaveBeenCalledWith(expect.stringContaining('marker'), 'start');
  expect(jumps).toHaveBeenCalledWith(expect.stringContaining('elsewhere'), 'center');
  expect(landed).toHaveBeenCalledTimes(1);
  expect(document.querySelector('.message.highlighted')?.textContent).toContain('elsewhere');
  await new Promise((resolve) => setTimeout(resolve, 550));
  expect(read).not.toHaveBeenCalled();
});

test('a notification context stays put at its forward end until the reader jumps to latest', async () => {
  const roomTimeline = timeline();
  roomTimeline.patch({ items: [readMarker('marker'), item('latest')] });
  const resume = vi.fn(() => {
    roomTimeline.patch({ mode: { kind: 'live' } });
    return Promise.resolve();
  });
  render(TimelineListHarness, {
    props: {
      list: {
        timeline: roomTimeline,
        landingEventId: '$elsewhere',
        onRequestUnread: (eventId: string) => {
          roomTimeline.patch({ mode: { kind: 'unread', event_id: eventId } });
          roomTimeline.patch({ forwardPagination: 'end' });
          roomTimeline.patch({ items: [item('before'), item('elsewhere'), item('after')] });
          return Promise.resolve();
        },
        onRequestHistory: () => Promise.resolve(true),
        onRequestFuture: () => Promise.resolve(),
        onRead: () => Promise.resolve(),
        onResumeLive: resume,
        onJumpToLive: () => {},
      },
    },
  });

  viewport();
  await flushed();
  await runAnimationFrames();
  expect(document.querySelector('.message.highlighted')?.textContent).toContain('elsewhere');
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(resume).not.toHaveBeenCalled();

  await userEvent.click(screen.getByRole('button', { name: 'Jump to latest' }));
  expect(resume).toHaveBeenCalledTimes(1);
});

test('a notification for an unloaded thread reply lands on its root', async () => {
  const jumps = vi.spyOn(TimelineWindow.prototype, 'jumpTo');
  const roomTimeline = timeline();
  roomTimeline.patch({ items: [readMarker('marker'), item('latest')] });
  const requestUnread = vi.fn((eventId: string) => {
    roomTimeline.patch({ mode: { kind: 'unread', event_id: eventId } });
    roomTimeline.patch({
      items: [item('root'), { ...item('reply'), thread_root: '$root' }, item('after')],
    });
    return Promise.resolve();
  });
  render(TimelineListHarness, {
    props: {
      list: {
        timeline: roomTimeline,
        landingEventId: '$reply',
        onRequestUnread: requestUnread,
        onRequestHistory: () => Promise.resolve(true),
        onRequestFuture: () => Promise.resolve(),
        onRead: () => Promise.resolve(),
      },
    },
  });

  viewport();
  await flushed();
  await runAnimationFrames();

  expect(requestUnread).toHaveBeenCalledTimes(1);
  expect(jumps).toHaveBeenCalledWith(expect.stringContaining('root'), 'center');
  expect(document.querySelector('.message.highlighted')?.textContent).toContain('root');
});

test('does not eagerly paginate a scrollable initial timeline', async () => {
  const roomTimeline = timeline();
  roomTimeline.patch({ items: Array.from({ length: 20 }, (_, index) => item(String(index))) });
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
  await flushed();
  await runAnimationFrames();

  expect(history).not.toHaveBeenCalled();
});

test('does not read a viewport removed during initial positioning', async () => {
  const roomTimeline = timeline();
  roomTimeline.patch({ items: [item('latest')] });
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
  await flushed();
  instance.unmount();
  await runAnimationFrames();
});

test('leaves follow mode for a scroll it did not write, whatever produced it', async () => {
  const roomTimeline = timeline();
  roomTimeline.patch({ items: Array.from({ length: 20 }, (_, index) => item(String(index))) });
  roomTimeline.patch({ backwardPagination: 'end' });
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
  await flushed();
  await runAnimationFrames();

  element.scrollTop = 700;
  element.dispatchEvent(new Event('scroll'));
  await flushed();

  expect(document.querySelector('.jump-to-latest')).not.toBeNull();
  expect(history).not.toHaveBeenCalled();
});

test('requests one history page until the viewport leaves the top threshold', async () => {
  const roomTimeline = timeline();
  roomTimeline.patch({ items: Array.from({ length: 20 }, (_, index) => item(String(index))) });
  roomTimeline.patch({ mode: { kind: 'live' } });
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
  await flushed();
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
  roomTimeline.patch({ items: Array.from({ length: 20 }, (_, index) => item(String(index))) });
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
  await flushed();
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
  roomTimeline.patch({ items: Array.from({ length: 20 }, (_, index) => item(String(index))) });
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
  await flushed();
  await runAnimationFrames();
  history.mockClear();

  element.dispatchEvent(new WheelEvent('wheel', { deltaY: -200 }));
  element.scrollTop = 0;
  element.dispatchEvent(new Event('scroll'));
  await flushed();

  expect(history).toHaveBeenCalledTimes(1);
  element.dispatchEvent(new Event('scrollend'));
  await vi.advanceTimersByTimeAsync(160);
  await flushed();
  expect(history).toHaveBeenCalledTimes(1);
});

test('a fresh upward input requests the next settled history page', async () => {
  const roomTimeline = timeline();
  roomTimeline.patch({ items: Array.from({ length: 20 }, (_, index) => item(String(index))) });
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
  await flushed();
  await runAnimationFrames();
  history.mockClear();
  element.scrollTop = 0;

  element.dispatchEvent(new WheelEvent('wheel', { deltaY: -200 }));
  await finishWheelGesture(element);
  expect(history).toHaveBeenCalledTimes(1);
  roomTimeline.patch({ items: [item('older'), ...roomTimeline.items] });
  await flushed();
  await runAnimationFrames();
  element.scrollTop = 20;
  element.dispatchEvent(new Event('scroll'));
  await flushed();
  element.scrollTop = 0;
  element.dispatchEvent(new WheelEvent('wheel', { deltaY: -200 }));
  await finishWheelGesture(element);

  expect(history).toHaveBeenCalledTimes(2);
});

test('rate limits sparse history fill and continues until the server reports the end', async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
  try {
    const roomTimeline = timeline();
    roomTimeline.patch({ items: Array.from({ length: 20 }, (_, index) => item(String(index))) });
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
    await flushed();
    await runAnimationFrames();
    history.mockClear();
    element.scrollTop = 0;

    element.dispatchEvent(new WheelEvent('wheel', { deltaY: -200 }));
    await flushed();
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
    roomTimeline.patch({ items: Array.from({ length: 20 }, (_, index) => item(String(index))) });
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
    await flushed();
    await runAnimationFrames();
    history.mockClear();
    element.scrollTop = 0;

    element.dispatchEvent(new WheelEvent('wheel', { deltaY: -200 }));
    await flushed();
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
  roomTimeline.patch({ items: [item('latest')] });
  roomTimeline.patch({ backwardPagination: 'end' });
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
  await flushed();
  await runAnimationFrames();
  await vi.advanceTimersByTimeAsync(500);
  expect(read).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(999);
  expect(read).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);

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
async function mountLive(roomTimeline: InstanceType<typeof StaticTimeline>): Promise<LiveTimeline> {
  layOutRows();
  roomTimeline.patch({ mode: { kind: 'live' } });
  roomTimeline.patch({ backwardPagination: 'end' });
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
  await flushed();
  await runAnimationFrames();
  element.dispatchEvent(new Event('scroll'));
  await flushed();
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
  roomTimeline.patch({ items: liveItems(100) });
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
    await flushed();
  }
  expect(width).not.toHaveBeenCalled();

  width.mockReturnValue(200);
  observer.resize();
  expect(width).toHaveBeenCalledOnce();
});

test('a backward pagination keeps its loading pill between pages, then fades it away', async () => {
  const roomTimeline = timeline();
  roomTimeline.patch({ items: liveItems(20) });
  const { element } = await mountLive(roomTimeline);
  const beforeScroll = element.scrollTop;
  const beforeHeight = contentHeight();
  expect(document.querySelector('.history-loading')).toBeNull();

  roomTimeline.patch({ backwardPagination: 'loading' });
  await flushed();
  await runAnimationFrames();

  expect(document.querySelector('.history-loading')).not.toBeNull();
  expect(document.querySelector('.history-loading')?.textContent).toContain(
    'Loading older messages'
  );
  expect(contentHeight()).toBe(beforeHeight);
  expect(element.scrollTop).toBe(beforeScroll);

  roomTimeline.patch({ backwardPagination: 'idle' });
  await flushed();
  await runAnimationFrames();

  expect(document.querySelector('.history-loading')).not.toBeNull();
  expect(contentHeight()).toBe(beforeHeight);
  expect(element.scrollTop).toBe(beforeScroll);

  roomTimeline.patch({ backwardPagination: 'loading' });
  await new Promise((resolve) => setTimeout(resolve, TIMELINE_LAYOUT.historyLoadingLinger));
  await flushed();
  expect(document.querySelector('.history-loading')).not.toBeNull();

  roomTimeline.patch({ backwardPagination: 'idle' });
  await new Promise((resolve) => setTimeout(resolve, TIMELINE_LAYOUT.historyLoadingLinger + 50));
  await flushed();
  await runAnimationFrames();
  expect(document.querySelector('.history-loading')?.hasAttribute('inert')).toBe(true);
});

async function dragTo(element: HTMLDivElement, from: number, to: number): Promise<void> {
  touch(element, 'touchstart', from < to ? 200 : 100);
  element.dispatchEvent(new Event('scroll'));
  await flushed();
  touch(element, 'touchmove', from < to ? 160 : 140);
  element.scrollTop = to;
  element.dispatchEvent(new Event('scroll'));
  await flushed();
}

function followingLive(): boolean {
  return currentLiveList.followingLive;
}

function liveItems(count: number): ResolvedItem[] {
  return Array.from({ length: count }, (_, index) => item(String(index)));
}

test('reading back inside the near-latest band leaves follow mode', async () => {
  const roomTimeline = timeline();
  roomTimeline.patch({ items: liveItems(20) });
  const { element, end } = await mountLive(roomTimeline);
  expect(document.querySelectorAll('.item').length).toBeGreaterThan(0);
  expect(followingLive()).toBe(true);

  await dragTo(element, end, end - 30);

  expect(followingLive()).toBe(false);
  expect(document.querySelector('.jump-to-latest')).toBeNull();
});

test('reading back past the band anchors', async () => {
  const roomTimeline = timeline();
  roomTimeline.patch({ items: liveItems(20) });
  const { element, end } = await mountLive(roomTimeline);

  await dragTo(element, end, end - 900);

  expect(followingLive()).toBe(false);
  expect(document.querySelector('.jump-to-latest')).not.toBeNull();
});

test('shows the jump control once the reader is a page behind the latest message', async () => {
  const roomTimeline = timeline();
  roomTimeline.patch({ items: liveItems(20) });
  const { element, end } = await mountLive(roomTimeline);

  await dragTo(element, end, end - element.clientHeight + 1);
  expect(followingLive()).toBe(false);
  expect(document.querySelector('.jump-to-latest')).toBeNull();

  await dragTo(element, end - element.clientHeight + 1, end - element.clientHeight);
  expect(followingLive()).toBe(false);
  expect(document.querySelector('.jump-to-latest')).not.toBeNull();

  await dragTo(element, end - element.clientHeight, end - element.clientHeight + 1);
  expect(document.querySelector('.jump-to-latest-motion')).toHaveAttribute('inert');
});

test('follows an own echo appended while the reader is still near latest', async () => {
  const roomTimeline = timeline();
  roomTimeline.patch({ items: liveItems(20) });
  const { element, end, setScrollHeight } = await mountLive(roomTimeline);

  await dragTo(element, end, end - 30);
  expect(followingLive()).toBe(false);

  touch(element, 'touchend', 170);
  await new Promise((resolve) => setTimeout(resolve, 160));
  await flushed();

  const ownEcho = {
    ...item('own-echo'),
    event_id: null,
    transaction_id: 'txn-own-echo',
    is_own: true,
    send_state: { status: 'sending' as const, progress: null },
  };
  roomTimeline.patch({ items: [...roomTimeline.items, ownEcho] });
  setScrollHeight(2_100);
  await flushed();
  await runAnimationFrames();

  expect(document.querySelectorAll('.item')).toHaveLength(21);
  expect(element.scrollHeight - element.clientHeight - element.scrollTop).toBe(0);
  expect(followingLive()).toBe(true);
});

test('follows an own message sent in a thread while the reader is near latest', async () => {
  const roomTimeline = timeline();
  roomTimeline.patch({ items: liveItems(20) });
  const { element, end, setScrollHeight } = await mountLive(roomTimeline);
  roomTimeline.patch({ mode: { kind: 'thread', root_event_id: '$root' } });
  await flushed();

  await dragTo(element, end, end - 30);
  touch(element, 'touchend', 170);
  await finishWheelGesture(element);

  roomTimeline.patch({
    items: [...roomTimeline.items, { ...item('own-thread-message'), is_own: true }],
  });
  setScrollHeight(2_100);
  await runAnimationFrames();

  expect(element.scrollHeight - element.clientHeight - element.scrollTop).toBe(0);
});

test('follows an own message that arrives already sent while the reader is near latest', async () => {
  const roomTimeline = timeline();
  roomTimeline.patch({ items: liveItems(20) });
  const { element, end, setScrollHeight } = await mountLive(roomTimeline);

  await dragTo(element, end, end - 30);
  touch(element, 'touchend', 170);
  await new Promise((resolve) => setTimeout(resolve, 160));
  await flushed();
  expect(followingLive()).toBe(false);

  roomTimeline.patch({
    items: [
      ...roomTimeline.items,
      { ...item('own-sent'), event_id: '$own-sent', transaction_id: 'txn-own-sent', is_own: true },
    ],
  });
  setScrollHeight(2_100);
  await flushed();
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
  roomTimeline.patch({ items: liveItems(20) });
  const { element, end } = await mountLive(roomTimeline);

  await dragTo(element, end, end - 30);
  touch(element, 'touchend', 170);
  await new Promise((resolve) => setTimeout(resolve, 160));
  await flushed();
  expect(followingLive()).toBe(false);

  focusComposer();
  await flushed();
  await runAnimationFrames();

  expect(element.scrollHeight - element.clientHeight - element.scrollTop).toBe(0);
  expect(followingLive()).toBe(true);
});

test('focusing the composer leaves a reader past the band where they are', async () => {
  const roomTimeline = timeline();
  roomTimeline.patch({ items: liveItems(20) });
  const { element, end } = await mountLive(roomTimeline);

  await dragTo(element, end, end - 900);
  touch(element, 'touchend', 170);
  await new Promise((resolve) => setTimeout(resolve, 160));
  await flushed();

  focusComposer();
  await flushed();
  await runAnimationFrames();

  expect(element.scrollTop).toBe(end - 900);
  expect(followingLive()).toBe(false);
});

test('leaves a reader deep in history where they are when they send', async () => {
  const roomTimeline = timeline();
  roomTimeline.patch({ items: liveItems(20) });
  const { element, end, setScrollHeight } = await mountLive(roomTimeline);

  await dragTo(element, end, end - 900);
  expect(followingLive()).toBe(false);

  touch(element, 'touchend', 170);
  await new Promise((resolve) => setTimeout(resolve, 160));
  await flushed();

  roomTimeline.patch({
    items: [
      ...roomTimeline.items,
      {
        ...item('own-echo'),
        event_id: null,
        transaction_id: 'txn-own-echo',
        is_own: true,
        send_state: { status: 'sending' as const, progress: null },
      },
    ],
  });
  setScrollHeight(2_100);
  await flushed();
  await runAnimationFrames();

  expect(followingLive()).toBe(false);
});

test('scrolling back to the end restores follow mode', async () => {
  const roomTimeline = timeline();
  roomTimeline.patch({ items: liveItems(20) });
  const { element, end } = await mountLive(roomTimeline);

  await dragTo(element, end, end - 900);
  expect(followingLive()).toBe(false);

  await dragTo(element, end - 900, end);

  expect(followingLive()).toBe(true);
});

test('hides the jump control when a content shrink clamps an anchored reader to the end', async () => {
  const roomTimeline = timeline();
  roomTimeline.patch({ items: liveItems(20) });
  const { element, end, setScrollHeight } = await mountLive(roomTimeline);

  await dragTo(element, end, end - 900);
  expect(followingLive()).toBe(false);

  setScrollHeight(1_000);
  element.scrollTop = element.scrollHeight - element.clientHeight;
  element.dispatchEvent(new Event('scroll'));
  await flushed();

  expect(followingLive()).toBe(true);
});

function contentHeight(): number {
  const element = document.querySelector('.items');
  if (!(element instanceof HTMLElement)) throw new Error('timeline content not found');
  return Number.parseFloat(element.style.height);
}

test('a tab restore keeps the row heights it measured', async () => {
  const roomTimeline = timeline();
  roomTimeline.patch({ items: liveItems(20) });
  await mountLive(roomTimeline);
  const measured = contentHeight();
  expect(measured).toBeGreaterThan(20 * ROW * 0.5);

  document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
  await runAnimationFrames();

  expect(contentHeight()).toBeGreaterThanOrEqual(measured);
});

test('a tab restore re-reads a rendered row whose measurement went stale', async () => {
  const roomTimeline = timeline();
  roomTimeline.patch({ items: liveItems(20) });
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
  roomTimeline.patch({ items: liveItems(20) });
  const { element, end } = await mountLive(roomTimeline);

  element.dispatchEvent(new WheelEvent('wheel', { deltaY: -30 }));
  element.scrollTop = end - 30;
  element.dispatchEvent(new Event('scroll'));
  await flushed();

  expect(followingLive()).toBe(false);
});

test('a repeated scroll notification near latest preserves the reading position', async () => {
  const roomTimeline = timeline();
  roomTimeline.patch({ items: liveItems(20) });
  const { element, end } = await mountLive(roomTimeline);

  await dragTo(element, end, end - 30);
  expect(followingLive()).toBe(false);
  element.dispatchEvent(new Event('scroll'));
  await flushed();

  expect(followingLive()).toBe(false);
});

test('middle-button autoscroll leaves follow mode', async () => {
  const roomTimeline = timeline();
  roomTimeline.patch({ items: liveItems(20) });
  const { element, end } = await mountLive(roomTimeline);

  element.dispatchEvent(new PointerEvent('pointerdown', { button: 1 }));
  element.scrollTop = end - 900;
  element.dispatchEvent(new Event('scroll'));
  await flushed();

  expect(followingLive()).toBe(false);
});

test('a scrollbar drag leaves follow mode like any other reading back', async () => {
  const roomTimeline = timeline();
  roomTimeline.patch({ items: liveItems(20) });
  const { element, end } = await mountLive(roomTimeline);

  element.dispatchEvent(new PointerEvent('pointerdown', { button: 0 }));
  element.scrollTop = end - 900;
  element.dispatchEvent(new Event('scroll'));
  await flushed();

  expect(followingLive()).toBe(false);
});

test('a hidden-only opening page stops after a few attempts until new items arrive', async () => {
  const roomTimeline = timeline();
  roomTimeline.patch({ items: [hiddenItem('renamed')] });
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
  await flushed();
  for (let round = 0; round < 30; round += 1) {
    await runAnimationFrames();
  }

  expect(history).toHaveBeenCalledTimes(MAX_EMPTY_REFILLS);
});

test('a window of hidden events keeps the skeleton rather than the filtered notice', async () => {
  const roomTimeline = timeline();
  roomTimeline.patch({ items: [hiddenItem('renamed')] });
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
  await flushed();
  await runAnimationFrames();

  expect(document.querySelector('.timeline-empty')).toBeNull();
  expect(document.querySelector('.timeline-placeholder')).not.toBeNull();

  roomTimeline.patch({ backwardPagination: 'end' });
  await flushed();
  await runAnimationFrames();

  expect(document.querySelector('.timeline-empty')).not.toBeNull();
});

test('requests history once a page in flight at opening is done', async () => {
  const roomTimeline = timeline();
  roomTimeline.patch({ items: [item('latest')] });
  roomTimeline.patch({ backwardPagination: 'loading' });
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
  await flushed();
  await runAnimationFrames();

  expect(history).not.toHaveBeenCalled();

  roomTimeline.patch({ backwardPagination: 'idle' });
  await flushed();
  await runAnimationFrames();

  expect(history).toHaveBeenCalled();
});

test('asks for history again when the timeline is cleared mid-session', async () => {
  const roomTimeline = timeline();
  roomTimeline.patch({ items: [item('latest')] });
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
  await flushed();
  await runAnimationFrames();
  await runAnimationFrames();
  const opening = history.mock.calls.length;

  roomTimeline.patch({ items: [] });
  await flushed();
  await runAnimationFrames();

  expect(history.mock.calls.length).toBeGreaterThan(opening);
});

test('a cleared timeline is not held back by the start it reached before', async () => {
  const roomTimeline = timeline();
  roomTimeline.patch({ items: [item('latest')] });
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
  await flushed();
  await runAnimationFrames();
  const opening = history.mock.calls.length;
  expect(opening).toBeGreaterThan(0);

  roomTimeline.patch({ items: [] });
  await flushed();
  await runAnimationFrames();

  expect(history.mock.calls.length).toBeGreaterThan(opening);
});

test('an empty timeline stops when its refill reports the timeline start', async () => {
  const roomTimeline = timeline();
  roomTimeline.patch({ items: [item('latest')] });
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
  await flushed();
  await runAnimationFrames();

  roomTimeline.patch({ items: [] });
  await flushed();
  await runAnimationFrames();
  await flushed();
  const afterClear = history.mock.calls.length;
  expect(afterClear).toBeGreaterThan(0);

  roomTimeline.patch({ backwardPagination: 'loading' });
  await flushed();
  roomTimeline.patch({ backwardPagination: 'idle' });
  await flushed();
  await runAnimationFrames();

  expect(history).toHaveBeenCalledTimes(afterClear);
});

test('a failed history request does not pass for the timeline start', async () => {
  const roomTimeline = timeline();
  roomTimeline.patch({ items: [] });
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
  await flushed();
  await runAnimationFrames();
  expect(history).toHaveBeenCalledTimes(MAX_EMPTY_REFILLS);

  roomTimeline.patch({ items: [item('arrived')] });
  await flushed();
  await runAnimationFrames();

  expect(history.mock.calls.length).toBeGreaterThan(MAX_EMPTY_REFILLS);
});

test('a reset during a held touch does not paint placeholders over the rendered rows', async () => {
  const roomTimeline = timeline();
  roomTimeline.patch({ items: Array.from({ length: 20 }, (_, index) => item(String(index))) });
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
  await flushed();
  await runAnimationFrames();
  expect(document.querySelectorAll('.window-rows > .item').length).toBeGreaterThan(0);

  touch(element, 'touchstart', 10);
  element.scrollTop = 10;
  element.dispatchEvent(new Event('scroll'));
  roomTimeline.patch({ items: [] });
  await flushed();
  await runAnimationFrames();

  expect({
    placeholder: document.querySelector('.timeline-placeholder') !== null,
    rendered: document.querySelectorAll('.window-rows > .item').length > 0,
  }).not.toEqual({ placeholder: true, rendered: true });
});

test('a permalink offers a way back to the live timeline', async () => {
  const roomTimeline = timeline();
  roomTimeline.patch({ items: Array.from({ length: 20 }, (_, index) => item(String(index))) });
  roomTimeline.patch({ mode: { kind: 'focused', event_id: '$5' } });
  roomTimeline.patch({ forwardPagination: 'end' });
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
  await flushed();
  await runAnimationFrames();

  const jump = screen.queryByRole('button', { name: 'Jump to latest' });
  expect(jump, 'a focused timeline has no other way back to the present').toBeInTheDocument();
  if (jump) await userEvent.click(jump);
  expect(jumpToLive).toHaveBeenCalled();
});

test('paginating forward out of a permalink reports that it is loading', async () => {
  const roomTimeline = timeline();
  roomTimeline.patch({ items: Array.from({ length: 20 }, (_, index) => item(String(index))) });
  roomTimeline.patch({ mode: { kind: 'focused', event_id: '$5' } });
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
  await flushed();
  await runAnimationFrames();
  expect(document.querySelector('.future-loading')).toBeNull();

  roomTimeline.patch({ forwardPagination: 'loading' });
  await flushed();

  expect(document.querySelector('.future-loading')).not.toBeNull();
});

test.each(['success', 'failure'] as const)(
  'stops rendering the read marker when a visible receipt has %s',
  async (result) => {
    const roomTimeline = timeline();
    roomTimeline.patch({
      items: Array.from({ length: 5 }, (_, index) => item(`old-${String(index)}`)),
    });
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
    await flushed();
    await runAnimationFrames();
    await vi.waitFor(() => {
      expect(read).toHaveBeenCalled();
    });

    roomTimeline.patch({ items: [...roomTimeline.items, readMarker('marker'), item('arrival')] });
    await flushed();
    await runAnimationFrames();

    expect(document.querySelector('.unread')).toBeNull();
    expect(document.querySelector('[data-item-id="arrival"]')).not.toBeNull();
  }
);

test('a reader at the latest message also reads the hidden events after it', async () => {
  setPreference('hideMembershipEvents', true);
  const roomTimeline = timeline();
  const join: ResolvedItem = withRowFields({
    ...item('join'),
    content: {
      kind: 'membership',
      change: 'joined',
      user_id: '@bob:example.org',
      display_name: 'Bob',
      reason: null,
    },
  });
  const old = Array.from({ length: 5 }, (_, index) => item(`old-${String(index)}`));
  roomTimeline.patch({ items: [...old, join], rows: rowsOf(old) });
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
  await flushed();
  await runAnimationFrames();

  expect(document.querySelector('[data-item-id="join"]')).toBeNull();
  await vi.waitFor(() => {
    expect(read).toHaveBeenLastCalledWith('$join', true);
  });
  setPreference('hideMembershipEvents', false);
});

test('the read marker waits for the latest message or for the reader to leave', async () => {
  const roomTimeline = timeline();
  roomTimeline.loadMarker = () => Promise.resolve('$read');
  roomTimeline.patch({
    items: [item('read'), ...Array.from({ length: 12 }, (_, i) => item(`new-${i}`))],
  });
  const read = vi.fn((_eventId: string, _fullyRead: boolean) => Promise.resolve());
  const fullyRead = vi.fn();
  const { unmount } = render(TimelineListHarness, {
    props: {
      list: {
        timeline: roomTimeline,
        roomId: '!room:example.org',
        hasUnread: true,
        onRequestHistory: () => Promise.resolve(true),
        onRequestFuture: async () => {},
        onRead: read,
        onFullyRead: fullyRead,
      },
    },
  });
  unreadViewport();
  await flushed();
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

test.each(['focused', 'unfocused', 'hidden'] as const)(
  'with open-at-unread off the %s room sends a receipt for the latest message and keeps the read marker',
  async (activity) => {
    setPreference('openRoomsAtUnread', false);
    const focused = vi.spyOn(document, 'hasFocus').mockReturnValue(activity !== 'unfocused');
    const visible = vi
      .spyOn(document, 'visibilityState', 'get')
      .mockReturnValue(activity === 'hidden' ? 'hidden' : 'visible');
    const roomTimeline = timeline();
    const unread = Array.from({ length: 12 }, (_, i) => item(`new-${i}`));
    roomTimeline.loadMarker = () => Promise.resolve('$read');
    roomTimeline.patch({ items: [item('read'), ...unread] });
    const read = vi.fn((_eventId: string, _fullyRead: boolean) => Promise.resolve());
    const list = {
      timeline: roomTimeline,
      roomId: '!room:example.org',
      hasUnread: true,
      onRequestHistory: () => Promise.resolve(true),
      onRequestFuture: async () => {},
      onRead: read,
    };
    const { rerender } = render(TimelineListHarness, { props: { list } });
    const element = unreadViewport();
    const jumps = vi.spyOn(TimelineWindow.prototype, 'jumpTo');
    await flushed();
    await runAnimationFrames();

    if (activity !== 'focused') {
      await new Promise((resolve) => setTimeout(resolve, 550));
      expect(read).not.toHaveBeenCalled();
      focused.mockReturnValue(true);
      visible.mockReturnValue('visible');
      window.dispatchEvent(new Event('focus'));
      document.dispatchEvent(new Event('visibilitychange'));
      await runAnimationFrames();
    }

    await vi.waitFor(() => {
      expect(read).toHaveBeenCalledWith('$new-11', false);
    });
    expect(element.scrollTop).toBe(element.scrollHeight - element.clientHeight);
    expect(jumps.mock.calls.some(([key]) => key?.includes('new-0'))).toBe(false);
    expect(screen.getByRole('button', { name: 'Jump to unread' })).toHaveTextContent(
      '12 new messages'
    );

    roomTimeline.patch({ items: [item('read'), ...unread, readMarker('moved')] });
    await rerender({ list: { ...list, hasUnread: false } });
    await runAnimationFrames();
    await userEvent.click(screen.getByRole('button', { name: 'Jump to unread' }));
    await runAnimationFrames();

    expect(jumps).toHaveBeenCalledWith(
      expect.stringContaining('new-0'),
      'start',
      false,
      expect.any(AbortSignal)
    );
    expect(screen.queryByRole('button', { name: 'Jump to unread' })).not.toBeInTheDocument();
    expect(document.querySelectorAll('.unread')).toHaveLength(1);
    expect(
      document
        .querySelector('.unread')
        ?.closest('[data-item-id]')
        ?.nextElementSibling?.getAttribute('data-item-id')
    ).toBe('new-0');
  }
);

test('closing a room opened at latest keeps its fully read marker', async () => {
  setPreference('openRoomsAtUnread', false);
  const roomTimeline = timeline();
  roomTimeline.loadMarker = () => Promise.resolve('$read');
  roomTimeline.patch({
    items: [item('read'), ...Array.from({ length: 12 }, (_, i) => item(`new-${i}`))],
  });
  const read = vi.fn((_eventId: string, _fullyRead: boolean) => Promise.resolve());
  const fullyRead = vi.fn();
  const { unmount } = render(TimelineListHarness, {
    props: {
      list: {
        timeline: roomTimeline,
        roomId: '!room:example.org',
        hasUnread: true,
        onRequestHistory: () => Promise.resolve(true),
        onRequestFuture: async () => {},
        onRead: read,
        onFullyRead: fullyRead,
      },
    },
  });
  unreadViewport();
  await flushed();
  await runAnimationFrames();
  await vi.waitFor(() => {
    expect(read).toHaveBeenCalledWith('$new-11', false);
  });

  unmount();
  expect(fullyRead).not.toHaveBeenCalled();
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

test('opening a large unread backlog reveals the room before an older page finishes', async () => {
  const roomTimeline = timeline();
  roomTimeline.loadMarker = () => Promise.resolve('$old-marker');
  roomTimeline.patch({ items: Array.from({ length: 30 }, (_, index) => item(`recent-${index}`)) });
  const historyPage = Promise.withResolvers<boolean>();
  const history = vi.fn(() => historyPage.promise);
  render(TimelineListHarness, {
    props: {
      list: {
        timeline: roomTimeline,
        hasUnread: true,
        onRequestHistory: history,
        onRequestFuture: () => Promise.resolve(),
        onRead: () => Promise.resolve(),
      },
    },
  });
  unreadViewport();
  await flushed();
  await runAnimationFrames();
  expect(timelineViewport()).not.toHaveClass('initial');
  expect(history).not.toHaveBeenCalled();
  historyPage.resolve(false);
  await runAnimationFrames();
});

test('a slow marker lookup leaves messages visible and receipts blocked', async () => {
  const roomTimeline = timeline();
  roomTimeline.patch({ items: Array.from({ length: 30 }, (_, index) => item(`recent-${index}`)) });
  const marker = Promise.withResolvers<string | null>();
  roomTimeline.loadMarker = () => marker.promise;
  const read = vi.fn().mockResolvedValue(undefined);
  render(TimelineListHarness, {
    props: {
      list: {
        timeline: roomTimeline,
        hasUnread: true,
        onRequestHistory: () => Promise.resolve(false),
        onRequestFuture: () => Promise.resolve(),
        onRead: read,
      },
    },
  });
  unreadViewport();
  await flushed();
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
  roomTimeline.loadMarker = () => Promise.resolve('$old-marker');
  roomTimeline.patch({ items: Array.from({ length: 30 }, (_, index) => item(`recent-${index}`)) });
  const history = vi.fn().mockResolvedValue(false);
  const jump = vi.fn();
  render(TimelineListHarness, {
    props: {
      list: {
        timeline: roomTimeline,
        hasUnread: true,
        onRequestHistory: history,
        onRequestFuture: () => Promise.resolve(),
        onRead: () => Promise.resolve(),
        onRequestUnread: jump.mockImplementation(() => {
          roomTimeline.patch({ mode: { kind: 'unread', event_id: '$old-marker' } });
          roomTimeline.patch({ items: [item('old-marker'), item('first'), ...roomTimeline.items] });
          return Promise.resolve();
        }),
      },
    },
  });
  unreadViewport();
  await flushed();
  await runAnimationFrames();
  await userEvent.click(screen.getByRole('button', { name: 'Jump to unread' }));
  expect(jump).toHaveBeenCalledWith('$old-marker');
  expect(history).not.toHaveBeenCalled();
});

test('unread stays in its context at forward end while the reader is above the bottom', async () => {
  const roomTimeline = timeline();
  roomTimeline.patch({ mode: { kind: 'unread', event_id: '$read' } });
  roomTimeline.patch({
    items: [
      item('read'),
      readMarker('marker'),
      ...Array.from({ length: 30 }, (_, index) => item(`message-${index}`)),
    ],
  });
  const resume = vi.fn(() => {
    roomTimeline.patch({ mode: { kind: 'live' } });
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
  await flushed();
  await runAnimationFrames();
  expect(node.scrollTop).toBeLessThan(node.scrollHeight - node.clientHeight);
  expect(resume).not.toHaveBeenCalled();
  roomTimeline.patch({ forwardPagination: 'end' });
  await flushed();
  await runAnimationFrames();
  expect(resume).not.toHaveBeenCalled();
  expect(roomTimeline.mode.kind).toBe('unread');

  scrollToBottom(node);
  await runAnimationFrames();
  expect(resume).toHaveBeenCalledWith();
  expect(roomTimeline.mode.kind).toBe('live');
});

function scrollToBottom(node: HTMLDivElement): void {
  node.scrollTop = node.scrollHeight - node.clientHeight;
  node.dispatchEvent(new Event('scroll'));
}

test('a failed return to live offers a translated retry', async () => {
  const roomTimeline = timeline();
  roomTimeline.patch({ mode: { kind: 'unread', event_id: '$read' } });
  roomTimeline.patch({ forwardPagination: 'end' });
  roomTimeline.patch({ items: [item('read'), readMarker('marker'), item('first')] });
  const resume = vi
    .fn()
    .mockRejectedValueOnce(new Error('offline'))
    .mockImplementationOnce(() => {
      roomTimeline.patch({ mode: { kind: 'live' } });
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
  await flushed();
  await runAnimationFrames();
  scrollToBottom(node);
  await runAnimationFrames();
  const retry = await screen.findByRole('button', { name: 'Try again' });
  await userEvent.click(retry);
  await flushed();
  expect(resume).toHaveBeenCalledTimes(2);
  expect(screen.queryByRole('button', { name: 'Try again' })).not.toBeInTheDocument();
});

test('a notification below unread keeps the bar and blocks receipts until jumping back', async () => {
  const roomTimeline = timeline();
  roomTimeline.patch({
    items: [
      item('read'),
      readMarker('marker'),
      ...Array.from({ length: 12 }, (_, i) => item(`new-${i}`)),
    ],
  });
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
  await flushed();
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

test('a notification below unread sends the receipt once the reader reaches the latest message', async () => {
  const roomTimeline = timeline();
  roomTimeline.patch({
    items: [
      item('read'),
      readMarker('marker'),
      ...Array.from({ length: 12 }, (_, i) => item(`new-${i}`)),
    ],
  });
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
  const element = unreadViewport();
  await flushed();
  await runAnimationFrames();
  await new Promise((resolve) => setTimeout(resolve, 550));
  expect(read).not.toHaveBeenCalled();

  element.scrollTop = element.scrollHeight - element.clientHeight;
  element.dispatchEvent(new Event('scroll'));
  await flushed();
  await runAnimationFrames();

  await vi.waitFor(() => {
    expect(read).toHaveBeenCalledWith('$new-11', true);
  });
});

test('an unread context without an SDK marker lands before returning to live', async () => {
  const roomTimeline = timeline();
  roomTimeline.loadMarker = () => new Promise<string | null>(() => {});
  roomTimeline.patch({ mode: { kind: 'unread', event_id: '$read' } });
  roomTimeline.patch({ readMarkerEventId: '$read' });
  roomTimeline.patch({ forwardPagination: 'end' });
  roomTimeline.patch({
    items: [item('read'), ...Array.from({ length: 12 }, (_, i) => item(`new-${i}`))],
  });
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
        onRequestHistory: () => Promise.resolve(false),
        onRequestFuture: () => Promise.resolve(),
        onRead: () => Promise.resolve(),
        onResumeLive: resume,
      },
    },
  });
  unreadViewport();
  await flushed();
  await runAnimationFrames();
  expect(order[0]).toBe('jump:item:unread-marker');
  expect(order).toContain('resume');
});

test('the unread marker stays where the room opened while receipts move the read marker', async () => {
  const roomTimeline = timeline();
  const unread = Array.from({ length: 12 }, (_, i) => item(`new-${i}`));
  roomTimeline.patch({ items: [item('read'), readMarker('marker'), ...unread] });
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
  await flushed();
  await runAnimationFrames();
  const markerFollows = (): string | null | undefined =>
    document
      .querySelector('.unread')
      ?.closest('[data-item-id]')
      ?.nextElementSibling?.getAttribute('data-item-id');
  expect(markerFollows()).toBe('new-0');

  roomTimeline.patch({
    items: [item('read'), ...unread.slice(0, 6), readMarker('moved'), ...unread.slice(6)],
  });
  await flushed();
  await runAnimationFrames();
  expect(document.querySelectorAll('.unread')).toHaveLength(1);
  expect(markerFollows()).toBe('new-0');

  roomTimeline.patch({ items: [item('read'), ...unread] });
  await flushed();
  await runAnimationFrames();
  expect(markerFollows()).toBe('new-0');
});

test('marking the unread bar as read keeps it on failure and clears it on success', async () => {
  const roomTimeline = timeline();
  roomTimeline.patch({
    items: [readMarker('marker'), ...Array.from({ length: 12 }, (_, i) => item(`new-${i}`))],
  });
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
  await flushed();
  await runAnimationFrames();
  await userEvent.click(screen.getByRole('button', { name: 'Mark as read' }));
  expect(screen.getByRole('alert')).toHaveTextContent('Could not mark this room as read');
  expect(screen.getByRole('button', { name: 'Jump to unread' })).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Mark as read' }));
  await flushed();
  expect(screen.queryByRole('button', { name: 'Jump to unread' })).not.toBeInTheDocument();
});

test('Escape jumps to the latest message and marks the room read', async () => {
  const roomTimeline = timeline();
  roomTimeline.patch({
    items: [readMarker('marker'), ...Array.from({ length: 12 }, (_, i) => item(`new-${i}`))],
  });
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
  await flushed();
  await runAnimationFrames();
  jumps.mockClear();
  await userEvent.keyboard('{Escape}');
  await flushed();
  expect(jumps).toHaveBeenCalledWith(null, 'start', expect.anything());
  expect(mark).toHaveBeenCalledOnce();
});

test('Escape removes the unread marker once the room is already read', async () => {
  const roomTimeline = timeline();
  roomTimeline.patch({
    items: [
      item('read'),
      readMarker('marker'),
      ...Array.from({ length: 6 }, (_, i) => item(`new-${i}`)),
    ],
  });
  const mark = vi.fn().mockResolvedValue(undefined);
  const list = {
    timeline: roomTimeline,
    hasUnread: true,
    onRequestHistory: () => Promise.resolve(true),
    onRequestFuture: async () => {},
    onRead: async () => {},
    onMarkRead: mark,
  };
  const { rerender } = render(TimelineListHarness, { props: { list } });
  unreadViewport();
  await flushed();
  await runAnimationFrames();
  expect(document.querySelectorAll('.unread')).toHaveLength(1);
  await rerender({ list: { ...list, hasUnread: false } });
  await flushed();
  expect(document.querySelectorAll('.unread')).toHaveLength(1);
  await userEvent.keyboard('{Escape}');
  await vi.waitFor(() => {
    expect(document.querySelectorAll('.unread')).toHaveLength(0);
  });
});

test('an unread jump that cannot load its boundary reports it without paging history', async () => {
  const roomTimeline = timeline();
  roomTimeline.loadMarker = () => Promise.resolve('$read');
  roomTimeline.patch({ items: [item('later-1'), item('later-2'), item('later-3')] });
  const history = vi.fn(() => Promise.resolve(false));
  const read = vi.fn().mockResolvedValue(undefined);
  render(TimelineListHarness, {
    props: {
      list: {
        timeline: roomTimeline,
        hasUnread: true,
        onRequestHistory: history,
        onRequestFuture: async () => {},
        onRead: read,
      },
    },
  });
  unreadViewport();
  await flushed();
  await runAnimationFrames();
  expect(timelineViewport()).not.toHaveClass('initial');
  await userEvent.click(screen.getByRole('button', { name: 'Jump to unread' }));
  await runAnimationFrames();
  expect(screen.getByRole('alert')).toHaveTextContent('Could not load unread messages');
  expect(history).not.toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
});

test('a notification at the snapshot edge loads newer pages without needing another scroll', async () => {
  const roomTimeline = timeline();
  roomTimeline.patch({ mode: { kind: 'focused', event_id: '$notification' } });
  roomTimeline.patch({ items: [item('older'), item('notification')] });
  const future = vi.fn(() => {
    roomTimeline.patch({
      items: [...roomTimeline.items, item(`newer-${future.mock.calls.length}`)],
    });
    if (future.mock.calls.length === 2) roomTimeline.patch({ forwardPagination: 'end' });
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
  await flushed();
  await runAnimationFrames();
  expect(future).toHaveBeenCalledTimes(2);
  expect(document.querySelector('[data-item-id="newer-2"]')).not.toBeNull();
});

test('switching into a notification snapshot preserves the timeline attachment during opening', async () => {
  const roomTimeline = timeline();
  roomTimeline.patch({ loading: true });
  roomTimeline.patch({ hasSnapshot: false });
  const future = vi.fn(() => {
    roomTimeline.patch({ forwardPagination: 'end' });
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
  await flushed();
  await runAnimationFrames();
  roomTimeline.patch({ mode: { kind: 'focused', event_id: '$notification' } });
  roomTimeline.patch({ items: [item('older'), item('notification')] });
  roomTimeline.patch({ loading: false });
  roomTimeline.patch({ hasSnapshot: true });
  await flushed();
  await runAnimationFrames();
  expect(document.querySelector('.timeline-viewport')?.classList.contains('initial')).toBe(false);
  expect(future).toHaveBeenCalledTimes(1);
});

test.each(['wheel', 'touch', 'keyboard'] as const)(
  'a failed newer page can be retried with %s while already at the snapshot edge',
  async (input) => {
    const roomTimeline = timeline();
    roomTimeline.patch({ mode: { kind: 'focused', event_id: '$notification' } });
    roomTimeline.patch({ items: [item('older'), item('notification')] });
    const future = vi.fn(() => {
      if (future.mock.calls.length === 1) {
        roomTimeline.patch({ error: 'load_failed' });
        throw new Error('offline');
      }
      roomTimeline.patch({ error: null });
      roomTimeline.patch({ items: [...roomTimeline.items, item('newer')] });
      roomTimeline.patch({ forwardPagination: 'end' });
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
    await flushed();
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
  roomTimeline.patch({ mode: { kind: 'focused', event_id: '$notification' } });
  roomTimeline.patch({ items: [item('older'), item('notification')] });
  const future = vi.fn(() => {
    if (future.mock.calls.length > 1) {
      roomTimeline.patch({ items: [...roomTimeline.items, item('newer')] });
      roomTimeline.patch({ forwardPagination: 'end' });
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
  await flushed();
  await runAnimationFrames();
  expect(future).toHaveBeenCalledTimes(1);
  const top = node.scrollTop;
  node.dispatchEvent(new WheelEvent('wheel', { deltaY: 200 }));
  expect(node.scrollTop).toBe(top);
  await runAnimationFrames();
  expect(future).toHaveBeenCalledTimes(2);
  await finishWheelGesture(node);
  await runAnimationFrames();
  expect(document.querySelector('[data-item-id="newer"]')).not.toBeNull();
});

test.each(['scrolling', 'settled'])(
  'read receipts use matching row snapshots while %s',
  async (phase) => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
    const roomTimeline = timeline();
    roomTimeline.patch({ items: Array.from({ length: 12 }, (_, i) => item(String(i))) });
    const read = vi.fn().mockResolvedValue(undefined);
    const { unmount } = render(TimelineListHarness, {
      props: {
        list: {
          timeline: roomTimeline,
          landingEventId: '$0',
          onRequestHistory: () => Promise.resolve(true),
          onRequestFuture: async () => {},
          onRead: read,
        },
      },
    });
    const element = unreadViewport();
    await flushed();
    await runAnimationFrames();
    read.mockClear();

    element.scrollTop = 360;
    element.dispatchEvent(new WheelEvent('wheel', { deltaY: -50 }));
    element.dispatchEvent(new Event('scroll'));
    if (phase === 'scrolling') touch(element, 'touchstart', 0);
    await flushed();
    await runAnimationFrames();

    roomTimeline.patch({ items: roomTimeline.items.slice(1) });
    await flushed();
    await runAnimationFrames();
    await vi.advanceTimersByTimeAsync(600);
    await flushed();
    await runAnimationFrames();

    expect(read).toHaveBeenCalledWith('$5', false);
    expect(read).not.toHaveBeenCalledWith('$6', expect.anything());
    unmount();
  }
);

async function readsWhileSettings(open: boolean): Promise<ReturnType<typeof vi.fn>> {
  if (open) page.state.settings = { section: 'account' };
  const roomTimeline = timeline();
  roomTimeline.patch({ items: [item('latest')] });
  const read = vi.fn((_eventId: string, _fullyRead: boolean) => Promise.resolve());
  render(TimelineListHarness, {
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
  await flushed();
  await runAnimationFrames();
  await new Promise((resolve) => setTimeout(resolve, 700));
  return read;
}

test('a room with no settings over it is read', async () => {
  expect(await readsWhileSettings(false)).toHaveBeenCalled();
});

test('a room covered by the settings dialog is not read', async () => {
  expect(await readsWhileSettings(true)).not.toHaveBeenCalled();
});
