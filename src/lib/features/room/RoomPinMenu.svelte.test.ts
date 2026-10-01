// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';

import type { TimelineItemView } from '#src/generated/protocol';

vi.mock('#lib/core/context.js');
vi.mock('$app/state', () => import('#lib/test-support/app-state.js'));
vi.mock('$app/navigation', () => import('#lib/test-support/app-navigation.js'));
vi.mock('#lib/rooms/room-list.svelte.js', () => ({ useRoomList: () => ({ rooms: [] }) }));
vi.mock('#lib/personas/personas.svelte.js', () => ({
  usePersonaStore: () => ({ personas: [], load: () => Promise.resolve() }),
}));

import { core as baseCore } from '#lib/core/__mocks__/context.js';
import { timelineMediaItems } from './media/media-items.js';
import RoomPinMenuHarness from './RoomPinMenuHarness.test.svelte';

const core = Object.assign(baseCore, {
  pinnedEvents: vi.fn(() => Promise.resolve(['$image', '$second'])),
  eventItems: vi.fn(() => Promise.resolve([image, secondImage])),
  roomAccountData: vi.fn(() => Promise.resolve(null)),
  setRoomAccountData: vi.fn(() => Promise.resolve()),
  roomCosmetics: vi.fn(() => Promise.resolve({ users: [], space_id: null })),
});

const image = {
  id: '$image',
  event_id: '$image',
  transaction_id: null,
  send_state: null,
  sender: '@alice:example.org',
  sender_name: 'Alice',
  sender_avatar: null,
  timestamp: 0,
  content: {
    kind: 'image',
    html: null,
    filename: 'photo.png',
    caption: null,
    source: 'mxc://example.org/photo',
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
  thread_root: null,
  thread_summary: null,
  reactions: [],
  is_own: false,
  read_by: [],
  per_message_profile: null,
  bundled_link_previews: [],
  link_previews_removed: null,
  mention: 'none',
  forwarded: null,
} satisfies TimelineItemView;

const secondImage: TimelineItemView = {
  ...image,
  id: '$second',
  event_id: '$second',
  content: { ...image.content, filename: 'second.png', source: 'mxc://example.org/second' },
};

afterEach(() => {
  vi.unstubAllGlobals();
  core.fetchMedia.mockClear();
  core.session = null;
});

test.each([
  [false, 'click'],
  [false, 'keyboard'],
  [true, 'click'],
  [true, 'keyboard'],
] as const)('opens a pinned image (narrow=%s, activation=%s)', async (narrow, activation) => {
  core.session = { account_id: `${String(narrow)}-${activation}` };
  if (narrow) {
    vi.stubGlobal('matchMedia', () => ({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    }));
  }
  const user = userEvent.setup({ delay: null });
  const onOpenMedia = vi.fn();
  const onJump = vi.fn();
  render(RoomPinMenuHarness, {
    menu: { roomId: '!room:example.org', members: [], canPin: false, onJump, onOpenMedia },
  });

  await user.click(screen.getByRole('button', { name: 'Pinned messages' }));
  const button = await screen.findByRole('button', { name: 'Open photo.png' });
  if (activation === 'keyboard') {
    if (!narrow) {
      await vi.waitFor(() => {
        expect(screen.getByRole('button', { name: 'Close pinned messages' })).toHaveFocus();
      });
    }
    button.focus();
    await user.keyboard('{Enter}');
  } else {
    await user.click(button);
  }

  await vi.waitFor(() => {
    expect(onOpenMedia).toHaveBeenCalledWith(timelineMediaItems([secondImage, image]), '$image');
  });
  const viewer = await screen.findByRole('dialog', { name: 'Media viewer' });
  expect(viewer).toHaveTextContent('2 of 2');
  expect(core.fetchMedia).toHaveBeenCalledWith('mxc://example.org/photo', 0, 0);
  expect(onJump).not.toHaveBeenCalled();
  await vi.waitFor(() => {
    expect(screen.queryByRole('menu')).not.toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Pinned messages' })).not.toBeInTheDocument();
  });
});
