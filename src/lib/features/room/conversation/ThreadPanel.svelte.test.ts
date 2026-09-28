// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
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

import ThreadPanelHarness from './ThreadPanelHarness.test.svelte';

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
  render(ThreadPanelHarness, {
    panel: { roomId: '!room:example.org', rootEventId: '$root', onClose: () => {} },
  });

  await user.click(await screen.findByRole('button', { name: /second\.png/ }));

  const viewer = await screen.findByRole('dialog', { name: 'Media viewer' });
  expect(viewer).toHaveTextContent('Alice');
  expect(viewer).toHaveTextContent('2 of 2');
  expect(core.fetchMedia).toHaveBeenCalledWith('mxc://example.org/second.png', 0, 0);
});
