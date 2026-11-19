// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';

import type { RoomListItemView } from '#src/generated/protocol';
import type { CoreClient } from '#lib/core/client.svelte.js';
import { createCoreStub } from '#lib/core/__mocks__/context.js';
import { adoptQuietRooms, adoptShownRooms, unreadDot } from '#lib/rooms/quiet-rooms.svelte.js';
import { roomView } from '#lib/test-support/room-views.js';

import RoomOptionsMenuHarness from './RoomOptionsMenuHarness.test.svelte';

function room(roomId: string, overrides: Partial<RoomListItemView> = {}): RoomListItemView {
  return roomView({ room_id: roomId, name: roomId, ...overrides });
}

test('keeps Add to space visible while the room list refreshes', async () => {
  const user = userEvent.setup();
  const currentRoom = room('!room');
  const space = room('!space', { room_kind: 'space' });
  const spacePermissions = vi.fn<() => Promise<{ can_manage_children: boolean }>>(() =>
    Promise.resolve({ can_manage_children: true })
  );
  function roomPermissions({
    room_id,
  }: {
    room_id: string;
  }): Promise<{ can_manage_children: boolean }> {
    return room_id === space.room_id
      ? spacePermissions()
      : Promise.resolve({ can_manage_children: false });
  }
  const core = createCoreStub({
    rpc: {
      notifications: {
        settings: vi.fn().mockResolvedValue({ room: null, default: 'mentions' }),
      },
      members: { permissions: vi.fn(roomPermissions) },
    },
  }) as unknown as CoreClient;
  let refresh = () => {};

  render(RoomOptionsMenuHarness, {
    core,
    room: currentRoom,
    rooms: [currentRoom, space],
    registerRefresh: (next: () => void) => {
      refresh = next;
    },
  });

  await user.click(screen.getByRole('button', { name: 'Room options' }));
  expect(await screen.findByRole('menuitem', { name: 'Add to space' })).toBeInTheDocument();

  refresh();
  await new Promise((resolve) => setTimeout(resolve));

  expect(spacePermissions).toHaveBeenCalledOnce();
  expect(screen.getByRole('menuitem', { name: 'Add to space' })).toBeInTheDocument();
});

test('offers notification settings for a space', async () => {
  const user = userEvent.setup();
  const space = room('!space', { room_kind: 'space' });
  const core = createCoreStub({
    rpc: {
      notifications: {
        settings: vi.fn().mockResolvedValue({ room: null, default: 'mentions' }),
      },
      members: { permissions: vi.fn().mockResolvedValue({ can_manage_children: false }) },
    },
  }) as unknown as CoreClient;

  render(RoomOptionsMenuHarness, {
    core,
    room: space,
    rooms: [space],
    registerRefresh: () => {},
  });

  await user.click(screen.getByRole('button', { name: 'Room options' }));

  expect(await screen.findByRole('menuitem', { name: 'Notifications' })).toBeInTheDocument();
});

afterEach(() => {
  adoptQuietRooms([]);
  adoptShownRooms([]);
});

async function openUnreadDot(
  quietRoomIds: string[] = []
): Promise<ReturnType<typeof userEvent.setup>> {
  const user = userEvent.setup();
  const current = room('!room');
  const core = createCoreStub({
    rpc: {
      notifications: { settings: vi.fn().mockResolvedValue({ room: null, default: 'mentions' }) },
      members: { permissions: vi.fn().mockResolvedValue({ can_manage_children: false }) },
    },
  }) as unknown as CoreClient;

  render(RoomOptionsMenuHarness, {
    core,
    room: current,
    rooms: [current],
    quietRoomIds,
    registerRefresh: () => {},
  });

  await user.click(screen.getByRole('button', { name: 'Room options' }));
  await user.click(await screen.findByRole('menuitem', { name: 'Unread dot' }));
  return user;
}

test('checks the current unread dot choice', async () => {
  adoptQuietRooms(['!room']);
  await openUnreadDot();

  expect(await screen.findByRole('menuitemradio', { name: 'Hide' })).toBeChecked();
  expect(screen.getByRole('menuitemradio', { name: 'Default' })).not.toBeChecked();
  expect(screen.getByRole('menuitemradio', { name: 'Show' })).not.toBeChecked();
});

test.each([
  ['Show', 'show'],
  ['Hide', 'hide'],
  ['Default', 'default'],
])('the %s unread dot choice sets the room override', async (name, expected) => {
  adoptShownRooms(expected === 'default' ? ['!room'] : []);
  const user = await openUnreadDot();

  await user.click(await screen.findByRole('menuitemradio', { name }));

  expect(unreadDot('!room')).toBe(expected);
});

test('lets a room inside a quiet space be shown but not hidden again', async () => {
  const user = await openUnreadDot(['!room']);

  const hide = await screen.findByRole('menuitemradio', { name: 'Unread dot hidden by space' });
  expect(hide).toHaveAttribute('aria-disabled', 'true');
  await user.click(screen.getByRole('menuitemradio', { name: 'Show' }));

  expect(unreadDot('!room')).toBe('show');
});
