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
import { timelineMediaItems } from '#lib/ui/media/media-items.js';
import RoomPinMenuHarness from './RoomPinMenuHarness.test.svelte';
import { withRowFields } from '#lib/features/room/timeline/row-fixtures.js';
import { mediaViewerState } from '#lib/ui/media/media-viewer-state.svelte.ts';

const core = baseCore;
Object.assign(core.rpc.rooms, {
  cosmetics: vi.fn(() => Promise.resolve({ users: [], space_id: null })),
});
const timeline = Object.assign(baseCore.rpc.timeline, {
  pinnedEvents: vi.fn(() => Promise.resolve(['$image', '$second'])),
  eventItems: vi.fn(() => Promise.resolve([image, secondImage])),
  pinReadState: vi.fn(() =>
    Promise.resolve({ pinned_ids: ['$image', '$second'], unread: 2, fresh_ids: [] })
  ),
  markPinsSeen: vi.fn(({ pinned_ids }: { room_id: string; pinned_ids: string[] }) =>
    Promise.resolve({ pinned_ids, unread: 0, fresh_ids: [] })
  ),
  rpc: { account: {} },
});

const image = {
  row: 'message',
  forwardable: true,
  redactable: true,
  visibility: 'always',
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
  thread_root: null,
  thread_summary: null,
  reactions: [],
  is_own: false,
  read_by: [],
  read_timestamps: {},
  per_message_profile: null,
  bundled_link_previews: [],
  link_previews_removed: null,
  shared_by: null,
  redacted_on_ban: null,
  mention: 'none',
  forwarded: null,
  forum_title: null,
  shield: null,
} satisfies TimelineItemView;

const secondImage = withRowFields({
  ...image,
  id: '$second',
  event_id: '$second',
  content: { ...image.content, filename: 'second.png', source: 'mxc://example.org/second' },
});

afterEach(() => {
  vi.unstubAllGlobals();
  core.fetchMedia.mockClear();
  core.session = null;
  mediaViewerState.close();
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
  const onJump = vi.fn();
  const openPaneleSpy = vi.spyOn(mediaViewerState, 'openPanel');
  render(RoomPinMenuHarness, {
    menu: { roomId: '!room:example.org', members: [], canPin: false, onJump },
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
    expect(openPaneleSpy).toHaveBeenCalledWith(
      timelineMediaItems([secondImage, image]),
      '$image',
      expect.any(Function)
    );
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

test('shows the total pin count on the button, even once the pins are read', async () => {
  timeline.pinReadState.mockResolvedValueOnce({
    pinned_ids: ['$image', '$second'],
    unread: 0,
    fresh_ids: [],
  });
  render(RoomPinMenuHarness, {
    menu: {
      roomId: '!room:example.org',
      members: [],
      canPin: false,
      onJump: vi.fn(),
    },
  });

  const button = screen.getByRole('button', { name: 'Pinned messages' });
  await vi.waitFor(() => {
    expect(button).toHaveTextContent('2');
  });
});

test('reports the unread pin count and clears it once the pins are seen', async () => {
  const user = userEvent.setup({ delay: null });
  render(RoomPinMenuHarness, {
    menu: {
      roomId: '!room:example.org',
      members: [],
      canPin: false,
      onJump: vi.fn(),
    },
  });

  const unread = screen.getByTestId('pins-unread');
  await vi.waitFor(() => {
    expect(unread).toHaveTextContent('2');
  });
  await user.click(screen.getByRole('button', { name: 'Pinned messages' }));
  await vi.waitFor(() => {
    expect(unread).toHaveTextContent('0');
  });
});

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function menuFor(roomId: string) {
  return { roomId, members: [], canPin: false, onJump: vi.fn() };
}

function countRefreshes(roomId: string): number {
  return timeline.pinReadState.mock.calls.filter(([request]) => request.room_id === roomId).length;
}

test('a pin count refresh while the list loads still shows the pins', async () => {
  const user = userEvent.setup({ delay: null });
  const ids = deferred<string[]>();
  timeline.pinnedEvents.mockImplementationOnce(() => ids.promise);
  const menu = menuFor('!refresh-during-load:example.org');
  const { rerender } = render(RoomPinMenuHarness, { menu });

  await user.click(screen.getByRole('button', { name: 'Pinned messages' }));
  await vi.waitFor(() => {
    expect(timeline.pinnedEvents).toHaveBeenLastCalledWith({ room_id: menu.roomId });
  });
  await rerender({ revision: '$pin' });
  await vi.waitFor(() => {
    expect(countRefreshes(menu.roomId)).toBe(2);
  });
  ids.resolve(['$image', '$second']);

  expect(await screen.findByRole('button', { name: 'Open photo.png' })).toBeInTheDocument();
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
});

test('a pin count refresh while pins resolve still fills their rows', async () => {
  const user = userEvent.setup({ delay: null });
  const items = deferred<TimelineItemView[]>();
  timeline.eventItems.mockImplementationOnce(() => items.promise);
  const menu = menuFor('!refresh-during-resolve:example.org');
  const { rerender } = render(RoomPinMenuHarness, { menu });

  await user.click(screen.getByRole('button', { name: 'Pinned messages' }));
  await vi.waitFor(() => {
    expect(timeline.eventItems).toHaveBeenLastCalledWith({
      room_id: menu.roomId,
      event_ids: ['$second', '$image'],
    });
  });
  await rerender({ revision: '$pin' });
  await vi.waitFor(() => {
    expect(countRefreshes(menu.roomId)).toBe(2);
  });
  items.resolve([image, secondImage]);

  expect(await screen.findByRole('button', { name: 'Open photo.png' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Open second.png' })).toBeInTheDocument();
});

test('switching rooms while open drops the previous room pins', async () => {
  const user = userEvent.setup({ delay: null });
  const menu = menuFor('!switch-from:example.org');
  const { rerender } = render(RoomPinMenuHarness, { menu });

  await user.click(screen.getByRole('button', { name: 'Pinned messages' }));
  await screen.findByRole('button', { name: 'Open photo.png' });
  const next = deferred<string[]>();
  timeline.pinnedEvents.mockImplementationOnce(() => next.promise);
  await rerender({ menu: { ...menu, roomId: '!switch-to:example.org' } });

  await vi.waitFor(() => {
    expect(screen.queryByRole('button', { name: 'Open photo.png' })).not.toBeInTheDocument();
  });
  next.resolve([]);
});

test('ignores a late pins-seen reply from the previous room', async () => {
  const user = userEvent.setup({ delay: null });
  const seen = deferred<{ pinned_ids: string[]; unread: number; fresh_ids: string[] }>();
  timeline.markPinsSeen.mockImplementationOnce(() => seen.promise);
  const menu = menuFor('!late-from:example.org');
  const { rerender } = render(RoomPinMenuHarness, { menu });

  await user.click(screen.getByRole('button', { name: 'Pinned messages' }));
  await vi.waitFor(() => {
    expect(timeline.markPinsSeen).toHaveBeenLastCalledWith({
      room_id: menu.roomId,
      pinned_ids: ['$image', '$second'],
    });
  });
  const nextIds = ['$image', '$second', '$third'];
  timeline.pinReadState.mockResolvedValueOnce({ pinned_ids: nextIds, unread: 3, fresh_ids: [] });
  timeline.pinnedEvents.mockResolvedValueOnce(nextIds);
  await rerender({ menu: { ...menu, roomId: '!late-to:example.org' } });
  const button = screen.getByRole('button', { name: 'Pinned messages' });
  await vi.waitFor(() => {
    expect(timeline.markPinsSeen).toHaveBeenLastCalledWith({
      room_id: '!late-to:example.org',
      pinned_ids: nextIds,
    });
    expect(button).toHaveTextContent('3');
    expect(screen.getByTestId('pins-unread')).toHaveTextContent('0');
  });

  seen.resolve({ pinned_ids: ['$image'], unread: 4, fresh_ids: [] });
  await seen.promise;
  await Promise.resolve();

  expect(button).toHaveTextContent('3');
  expect(screen.getByTestId('pins-unread')).toHaveTextContent('0');
});
