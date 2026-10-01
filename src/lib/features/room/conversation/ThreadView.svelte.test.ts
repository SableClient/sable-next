// @vitest-environment happy-dom

import { fireEvent, render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';

import type { TimelineItemView } from '#src/generated/protocol';
import { RoomTimeline } from '#lib/rooms/timeline.svelte.js';

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

afterEach(() => {
  vi.restoreAllMocks();
  core.fetchMedia.mockReset();
});

function image(eventId: string, filename: string): TimelineItemView {
  return {
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
    per_message_profile: null,
    bundled_link_previews: [],
    link_previews_removed: null,
    mention: 'none',
    forwarded: null,
  };
}

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
    emote: false,
    notice: false,
    edited: false,
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

test('a failed subscription can be retried without replacing the composer', async () => {
  let attempts = 0;
  const start = vi.spyOn(RoomTimeline.prototype, 'startThread').mockImplementation(function (
    this: RoomTimeline
  ) {
    this.mode = { kind: 'thread', rootEventId: '$root' };
    attempts += 1;
    this.error = attempts === 1 ? 'load_failed' : null;
    this.hasSnapshot = attempts > 1;
    if (attempts > 1) this.items = [image('$root', 'first.png')];
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
