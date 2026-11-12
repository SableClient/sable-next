// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';

import type { RoomListItemView } from '#src/generated/protocol';
import type { CoreClient } from '#lib/core/client.svelte.js';
import { createCoreStub } from '#lib/core/__mocks__/context.js';
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
