// @vitest-environment happy-dom

import type { ResolvedItem } from '#lib/rooms/timeline-item.js';
import { fireEvent, render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';

import { RoomTimeline } from '#lib/rooms/timeline.svelte.js';
import type { StaticTimeline } from '#lib/test-support/static-timeline.svelte.js';

vi.mock('#lib/rooms/timeline.svelte.js', async (importActual) => {
  const actual = await importActual<typeof import('#lib/rooms/timeline.svelte.js')>();
  const { staticTimelineOf } = await import('#lib/test-support/static-timeline.svelte.js');
  return { ...actual, RoomTimeline: staticTimelineOf(actual.RoomTimeline, actual.NO_UNREAD) };
});
vi.mock('#lib/core/context.js');
vi.mock('#lib/rooms/room-list.svelte.js', () => ({ useRoomList: () => ({ rooms: [] }) }));
vi.mock('#lib/personas/personas.svelte.js', () => ({
  usePersonaStore: () => ({ personas: [], load: () => Promise.resolve() }),
}));
vi.mock('../messages/event-items.svelte.js', () => ({
  useEventItems: () => ({ get: () => undefined }),
}));

import { core } from '#lib/core/__mocks__/context.js';

import ThreadViewHarness from './ThreadViewHarness.test.svelte';
import { withRowFields } from '#lib/features/room/timeline/row-fixtures.js';

afterEach(() => {
  vi.restoreAllMocks();
  core.fetchMedia.mockReset();
});

function image(eventId: string, filename: string): ResolvedItem {
  return withRowFields({
    id: eventId,
    event_id: eventId,
    transaction_id: null,
    send_state: null,
    sender: '@alice:example.org',
    sender_name: 'Alice',
    sender_avatar: null,
    timestamp: 0,
    content: {
      kind: 'image',
      html: null,
      filename,
      caption: null,
      source: `mxc://example.org/${filename}`,
      mime: 'image/png',
      width: 800,
      height: 600,
      size: null,
      blurhash: null,
      thumbnail: null,
      spoiler: null,
      animated: null,
    },
    in_reply_to: null,
    thread_root: '$root',
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

test('an image in a thread opens the viewer on that image', async () => {
  vi.spyOn(RoomTimeline.prototype, 'startThread').mockImplementation(function (
    this: StaticTimeline
  ) {
    this.patch({ items: [image('$first', 'first.png'), image('$second', 'second.png')] });
    this.patch({ hasSnapshot: true });
    return Promise.resolve();
  });
  vi.spyOn(RoomTimeline.prototype, 'stop').mockResolvedValue();
  const user = userEvent.setup();
  render(ThreadViewHarness, {
    panel: { roomId: '!room:example.org', rootEventId: '$root', onClose: () => {} },
  });

  await user.click(await screen.findByRole('button', { name: 'Open second.png' }));

  const viewer = await screen.findByRole('dialog', { name: 'Media viewer' });
  expect(viewer).toHaveTextContent('Alice');
  expect(viewer).toHaveTextContent('2 of 2');
  expect(core.fetchMedia).toHaveBeenCalledWith('mxc://example.org/second.png', 0, 0);
});

test('the header keeps a spoiler-safe topic visible', async () => {
  const root = image('$root', 'first.png');
  root.content = {
    kind: 'message',
    body: 'Release secret',
    html: 'Release <span data-mx-spoiler>secret</span>',
    emote: false,
    notice: false,
    edited: false,
  };
  vi.spyOn(RoomTimeline.prototype, 'startThread').mockImplementation(function (
    this: StaticTimeline
  ) {
    this.patch({ items: [root] });
    this.patch({ hasSnapshot: true });
    return Promise.resolve();
  });
  vi.spyOn(RoomTimeline.prototype, 'stop').mockResolvedValue();
  render(ThreadViewHarness, {
    panel: { roomId: '!room:example.org', rootEventId: '$root', onClose: () => {} },
  });
  expect(await screen.findByRole('heading', { name: 'Release [Spoiler]' })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Back to conversation' })).toBeVisible();
  expect(screen.getByRole('button', { name: 'Jump to original message' })).toBeVisible();
});

test('a linked reply missing from the thread opens on its context', async () => {
  vi.spyOn(RoomTimeline.prototype, 'startThread').mockImplementation(function (
    this: StaticTimeline
  ) {
    this.patch({ items: [image('$root', 'first.png')] });
    this.patch({ hasSnapshot: true });
    return Promise.resolve();
  });
  const start = vi.spyOn(RoomTimeline.prototype, 'start').mockResolvedValue();
  const paginate = vi.spyOn(RoomTimeline.prototype, 'paginateBackward');
  vi.spyOn(RoomTimeline.prototype, 'stop').mockResolvedValue();
  render(ThreadViewHarness, {
    panel: {
      roomId: '!room:example.org',
      rootEventId: '$root',
      focusEventId: '$older',
      onClose: () => {},
    },
  });

  await vi.waitFor(() => {
    expect(start).toHaveBeenCalledWith('!room:example.org', '$older');
  });
  expect(paginate).not.toHaveBeenCalled();
});

test('a linked reply already in the thread keeps the thread timeline', async () => {
  vi.spyOn(RoomTimeline.prototype, 'startThread').mockImplementation(function (
    this: StaticTimeline
  ) {
    this.patch({ items: [image('$root', 'first.png'), image('$reply', 'reply.png')] });
    this.patch({ hasSnapshot: true });
    return Promise.resolve();
  });
  const start = vi.spyOn(RoomTimeline.prototype, 'start').mockResolvedValue();
  vi.spyOn(RoomTimeline.prototype, 'stop').mockResolvedValue();
  render(ThreadViewHarness, {
    panel: {
      roomId: '!room:example.org',
      rootEventId: '$root',
      focusEventId: '$reply',
      onClose: () => {},
    },
  });

  expect(await screen.findByRole('button', { name: 'Open reply.png' })).toBeVisible();
  expect(start).not.toHaveBeenCalled();
});

test('a plain thread offers no jump back to the thread', async () => {
  vi.spyOn(RoomTimeline.prototype, 'startThread').mockImplementation(function (
    this: StaticTimeline
  ) {
    this.patch({ mode: { kind: 'thread', root_event_id: '$root' } });
    this.patch({ items: [image('$root', 'first.png'), image('$reply', 'reply.png')] });
    this.patch({ hasSnapshot: true });
    return Promise.resolve();
  });
  vi.spyOn(RoomTimeline.prototype, 'stop').mockResolvedValue();
  render(ThreadViewHarness, {
    panel: { roomId: '!room:example.org', rootEventId: '$root', onClose: () => {} },
  });

  expect(await screen.findByRole('button', { name: 'Open reply.png' })).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Jump to latest' })).not.toBeInTheDocument();
});

test('a reply opened on its context jumps back to the live thread', async () => {
  vi.spyOn(Element.prototype, 'animate').mockImplementation(
    () =>
      ({
        cancel: () => {},
        effect: null,
        onfinish: null,
        playState: 'finished',
      }) as unknown as Animation
  );
  const startThread = vi.spyOn(RoomTimeline.prototype, 'startThread').mockImplementation(function (
    this: StaticTimeline
  ) {
    this.patch({ mode: { kind: 'thread', root_event_id: '$root' } });
    this.patch({ items: [image('$root', 'first.png')] });
    this.patch({ hasSnapshot: true });
    return Promise.resolve();
  });
  vi.spyOn(RoomTimeline.prototype, 'start').mockImplementation(function (this: StaticTimeline) {
    this.patch({ mode: { kind: 'focused', event_id: '$older' } });
    this.patch({ items: [image('$root', 'first.png'), image('$older', 'older.png')] });
    return Promise.resolve();
  });
  vi.spyOn(RoomTimeline.prototype, 'stop').mockResolvedValue();
  const user = userEvent.setup();
  render(ThreadViewHarness, {
    panel: {
      roomId: '!room:example.org',
      rootEventId: '$root',
      focusEventId: '$older',
      onClose: () => {},
    },
  });

  await user.click(await screen.findByRole('button', { name: 'Jump to latest' }));

  expect(startThread).toHaveBeenCalledTimes(2);
});

test('a failed subscription can be retried without replacing the composer', async () => {
  let attempts = 0;
  const start = vi.spyOn(RoomTimeline.prototype, 'startThread').mockImplementation(function (
    this: StaticTimeline
  ) {
    this.patch({ mode: { kind: 'thread', root_event_id: '$root' } });
    attempts += 1;
    this.patch({ error: attempts === 1 ? 'load_failed' : null });
    this.patch({ hasSnapshot: attempts > 1 });
    if (attempts > 1) this.patch({ items: [image('$root', 'first.png')] });
    return Promise.resolve();
  });
  vi.spyOn(RoomTimeline.prototype, 'stop').mockResolvedValue();
  const user = userEvent.setup();
  const { container } = render(ThreadViewHarness, {
    panel: { roomId: '!room:example.org', rootEventId: '$root', onClose: () => {} },
  });
  const composer = container.querySelector('.thread-composer');
  await user.click(await screen.findByRole('button', { name: 'Try again' }));
  expect(start).toHaveBeenCalledTimes(2);
  expect(await screen.findByRole('heading', { name: 'first.png' })).toBeVisible();
  expect(container.querySelector('.thread-composer')).toBe(composer);
});

test.each([false, true])(
  'read-only threads hide restricted actions (sidePanel=%s)',
  async (sidePanel) => {
    const root = image('$root', 'first.png');
    root.is_own = true;
    root.content = {
      kind: 'message',
      body: 'Read-only discussion',
      html: 'Read-only discussion',
      emote: false,
      notice: false,
      edited: false,
    };
    vi.spyOn(RoomTimeline.prototype, 'startThread').mockImplementation(function (
      this: StaticTimeline
    ) {
      this.patch({ items: [root] });
      this.patch({ hasSnapshot: true });
      return Promise.resolve();
    });
    vi.spyOn(RoomTimeline.prototype, 'stop').mockResolvedValue();
    const { container } = render(ThreadViewHarness, {
      panel: {
        roomId: '!room:example.org',
        rootEventId: '$root',
        sidePanel,
        readOnly: true,
        canReact: false,
        canPin: false,
        canRedactOwn: false,
        onClose: () => {},
      },
    });
    await screen.findByRole('heading', { name: 'Read-only discussion' });
    expect(container.querySelector('[contenteditable="true"]')).toBeNull();
    await fireEvent.contextMenu(screen.getByRole('article'));
    await screen.findByRole('menu');
    for (const name of ['Reply', 'Edit message', 'Add reaction', 'Pin message', 'Delete message']) {
      expect(screen.queryByRole('menuitem', { name })).not.toBeInTheDocument();
    }
    expect(screen.getByRole('menuitem', { name: 'Copy message' })).toBeVisible();
  }
);
