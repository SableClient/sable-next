// @vitest-environment happy-dom

import { fireEvent, render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';

import type { TimelineItemView } from '#src/generated/protocol';
import { RoomTimeline } from '#lib/rooms/timeline.svelte.js';
import { TimelineWindow } from '#lib/timeline/timeline-window.js';

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
import { mediaViewerState } from '#lib/ui/media/media-viewer-state.svelte.ts';

afterEach(() => {
  vi.restoreAllMocks();
  core.fetchMedia.mockReset();
  mediaViewerState.close();
});

function image(eventId: string, filename: string): TimelineItemView {
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
      external_url: null,
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
    shield: null,
  });
}

test.each([false, true])('thread quotes jump to messages (loaded=%s)', async (loaded) => {
  const reply = image('$reply', 'reply.png');
  reply.in_reply_to = {
    event_id: '$quoted',
    sender: '@alice:example.org',
    sender_name: 'Alice',
    sender_mentioned: false,
    body: 'Quoted message',
    fallback: null,
  };
  const startThread = vi.spyOn(RoomTimeline.prototype, 'startThread').mockImplementation(function (
    this: RoomTimeline
  ) {
    this.mode = { kind: 'thread', rootEventId: '$root' };
    this.items = loaded ? [image('$quoted', 'quoted.png'), reply] : [reply];
    this.hasSnapshot = true;
    return Promise.resolve();
  });
  const start = vi.spyOn(RoomTimeline.prototype, 'start').mockResolvedValue();
  vi.spyOn(RoomTimeline.prototype, 'stop').mockResolvedValue();
  const jumps = vi.spyOn(TimelineWindow.prototype, 'jumpTo').mockResolvedValue(true);
  const user = userEvent.setup();
  render(ThreadViewHarness, {
    panel: { roomId: '!room:example.org', rootEventId: '$root', onClose: () => {} },
  });

  const quote = await screen.findByRole('button', { name: 'Alice Quoted message' });
  jumps.mockClear();
  await user.click(quote);

  await vi.waitFor(() => {
    if (loaded) {
      expect(jumps).toHaveBeenCalledWith('event:$quoted', 'center', expect.any(Boolean));
    } else {
      expect(start).toHaveBeenCalledWith('!room:example.org', '$quoted');
    }
  });
  if (loaded) {
    expect(start).not.toHaveBeenCalled();
    expect(startThread).toHaveBeenCalledOnce();
  }
});

test('an image in a thread opens the viewer on that image', async () => {
  vi.spyOn(RoomTimeline.prototype, 'startThread').mockImplementation(function (this: RoomTimeline) {
    this.items = [image('$first', 'first.png'), image('$second', 'second.png')];
    this.hasSnapshot = true;
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
    msgtype: 'text',
    edited: false,
    jumbo: null,
  };
  vi.spyOn(RoomTimeline.prototype, 'startThread').mockImplementation(function (this: RoomTimeline) {
    this.items = [root];
    this.hasSnapshot = true;
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

test('the header shows the post title of a forum topic', async () => {
  const root = image('$root', 'first.png');
  root.forum_title = 'Release notes';
  vi.spyOn(RoomTimeline.prototype, 'startThread').mockImplementation(function (this: RoomTimeline) {
    this.items = [root];
    this.hasSnapshot = true;
    return Promise.resolve();
  });
  vi.spyOn(RoomTimeline.prototype, 'stop').mockResolvedValue();
  render(ThreadViewHarness, {
    panel: { roomId: '!room:example.org', rootEventId: '$root', onClose: () => {} },
  });
  expect(await screen.findByRole('heading', { name: 'Release notes' })).toBeVisible();
});

test('a linked reply missing from the thread opens on its context', async () => {
  vi.spyOn(RoomTimeline.prototype, 'startThread').mockImplementation(function (this: RoomTimeline) {
    this.items = [image('$root', 'first.png')];
    this.hasSnapshot = true;
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
  vi.spyOn(RoomTimeline.prototype, 'startThread').mockImplementation(function (this: RoomTimeline) {
    this.items = [image('$root', 'first.png'), image('$reply', 'reply.png')];
    this.hasSnapshot = true;
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
  vi.spyOn(RoomTimeline.prototype, 'startThread').mockImplementation(function (this: RoomTimeline) {
    this.mode = { kind: 'thread', rootEventId: '$root' };
    this.items = [image('$root', 'first.png'), image('$reply', 'reply.png')];
    this.hasSnapshot = true;
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
    this: RoomTimeline
  ) {
    this.mode = { kind: 'thread', rootEventId: '$root' };
    this.items = [image('$root', 'first.png')];
    this.hasSnapshot = true;
    return Promise.resolve();
  });
  vi.spyOn(RoomTimeline.prototype, 'start').mockImplementation(function (this: RoomTimeline) {
    this.mode = { kind: 'focused', eventId: '$older' };
    this.items = [image('$root', 'first.png'), image('$older', 'older.png')];
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

test.each([false, true])(
  'a failed thread can be retried without replacing the composer (cached=%s)',
  async (cached) => {
    let attempts = 0;
    const start = vi.spyOn(RoomTimeline.prototype, 'startThread').mockImplementation(function (
      this: RoomTimeline
    ) {
      this.mode = { kind: 'thread', rootEventId: '$root' };
      attempts += 1;
      this.error = attempts === 1 ? 'load_failed' : null;
      this.hasSnapshot = cached || attempts > 1;
      if (cached || attempts > 1) this.items = [image('$root', 'first.png')];
      return Promise.resolve();
    });
    const retry = vi.spyOn(RoomTimeline.prototype, 'retry').mockImplementation(function (
      this: RoomTimeline
    ) {
      return start.call(this, '!room:example.org', '$root');
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
    expect(retry).toHaveBeenCalledOnce();
    expect(container.querySelector('.thread-composer')).toBe(composer);
  }
);

test.each([false, true])(
  'read-only threads hide restricted actions (sidePanel=%s)',
  async (sidePanel) => {
    const root = image('$root', 'first.png');
    root.is_own = true;
    root.content = {
      kind: 'message',
      body: 'Read-only discussion',
      html: 'Read-only discussion',
      msgtype: 'text',
      edited: false,
      jumbo: null,
    };
    vi.spyOn(RoomTimeline.prototype, 'startThread').mockImplementation(function (
      this: RoomTimeline
    ) {
      this.items = [root];
      this.hasSnapshot = true;
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

test('jumping from thread media scrolls the thread to that message', async () => {
  vi.spyOn(RoomTimeline.prototype, 'startThread').mockImplementation(function (this: RoomTimeline) {
    this.items = [image('$first', 'first.png'), image('$second', 'second.png')];
    this.hasSnapshot = true;
    return Promise.resolve();
  });
  vi.spyOn(RoomTimeline.prototype, 'stop').mockResolvedValue();
  const jumps = vi.spyOn(TimelineWindow.prototype, 'jumpTo').mockResolvedValue(true);
  const user = userEvent.setup();
  render(ThreadViewHarness, {
    panel: { roomId: '!room:example.org', rootEventId: '$root', onClose: () => {} },
  });
  await user.click(await screen.findByRole('button', { name: 'Open second.png' }));
  jumps.mockClear();
  await user.click(screen.getByRole('button', { name: 'More actions' }));
  await user.click(await screen.findByRole('menuitem', { name: 'Jump to message' }));
  await vi.waitFor(() => {
    expect(jumps).toHaveBeenCalled();
  });
  expect(mediaViewerState.eventId).toBeNull();
  expect(screen.getByRole('region', { name: 'Thread' })).toBeInTheDocument();
});
