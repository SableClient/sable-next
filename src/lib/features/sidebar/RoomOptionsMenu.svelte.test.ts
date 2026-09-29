// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';

import type { RoomSummary } from '#src/generated/protocol';
import type { CoreClient } from '#lib/core/client.svelte.js';
import { createCoreStub } from '#lib/core/__mocks__/context.js';

import RoomOptionsMenuHarness from './RoomOptionsMenuHarness.test.svelte';

function room(roomId: string, overrides: Partial<RoomSummary> = {}): RoomSummary {
  return {
    room_id: roomId,
    canonical_alias: null,
    name: roomId,
    topic: null,
    avatar_url: null,
    is_direct: false,
    direct_targets: [],
    join_rule: 'invite',
    tags: [],
    state: 'joined',
    encrypted: null,
    is_space: false,
    is_tombstoned: false,
    is_voice: false,
    call_participants: [],
    room_type: null,
    supports_knock: false,
    supports_restricted: false,
    space_children: [],
    unread: 0,
    notifying: 0,
    highlight: 0,
    marked_unread: false,
    latest_event: null,
    ...overrides,
  } as RoomSummary;
}

test('keeps Add to space visible while the room list refreshes', async () => {
  const user = userEvent.setup();
  const currentRoom = room('!room');
  const space = room('!space', { is_space: true });
  const spacePermissions = vi.fn<() => Promise<{ can_manage_children: boolean }>>(() =>
    Promise.resolve({ can_manage_children: true })
  );
  function roomPermissions(roomId: string): Promise<{ can_manage_children: boolean }> {
    return roomId === space.room_id
      ? spacePermissions()
      : Promise.resolve({ can_manage_children: false });
  }
  const core = createCoreStub({
    roomPermissions: vi.fn(roomPermissions),
    notificationSettings: vi
      .fn()
      .mockResolvedValue({ room: null, default: 'mentions', bridged: false }),
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
