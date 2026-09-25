// @vitest-environment happy-dom

import { mount, tick, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

import type { TimelineItemView } from '#src/generated/protocol';
import { RoomTimeline } from '#lib/rooms/timeline.svelte.js';

vi.mock('#lib/core/context.js');
vi.mock('#lib/rooms/room-list.svelte.js', () => ({ useRoomList: () => ({ rooms: [] }) }));
vi.mock('#lib/personas/personas.svelte.js', () => ({
  usePersonaStore: () => ({ personas: [], load: () => Promise.resolve() }),
}));

import { core } from '#lib/core/__mocks__/context.js';

import ThreadPanelHarness from './ThreadPanelHarness.test.svelte';

afterEach(() => {
  vi.restoreAllMocks();
  core.fetchMedia.mockReset();
  document.body.replaceChildren();
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
    },
    in_reply_to: null,
    thread_root: '$root',
    thread_summary: null,
    reactions: [],
    is_own: false,
    read_by: [],
    per_message_profile: null,
    bundled_link_previews: [],
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
  const instance = mount(ThreadPanelHarness, {
    target: document.body,
    props: { panel: { roomId: '!room:example.org', rootEventId: '$root', onClose: () => {} } },
  });

  const second = await vi.waitFor(() => {
    const button = document.querySelector<HTMLButtonElement>(
      '[data-event-id="$second"] button.media-image'
    );
    if (!button) throw new Error('the thread image was not rendered');
    return button;
  });
  second.click();
  await tick();

  const viewer = document.querySelector('.viewer');
  expect(viewer?.textContent).toContain('Alice');
  expect(viewer?.textContent).toContain('2 of 2');
  expect(core.fetchMedia).toHaveBeenCalledWith('mxc://example.org/second.png', 0, 0);
  await unmount(instance);
});
