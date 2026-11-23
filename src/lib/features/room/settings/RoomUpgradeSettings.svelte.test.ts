// @vitest-environment happy-dom

import { render, screen, waitFor } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';

import type {
  RoomListItemView,
  RoomPermissionsView,
  RoomPowerLevelsView,
} from '#src/generated/protocol';

import { roomView, spaceChild } from '#lib/test-support/room-views.js';
import { reactiveToggle } from '#lib/test-support/toggle.svelte.js';

vi.mock('$app/navigation', () => import('#lib/test-support/app-navigation.js'));
vi.mock('$app/state', () => import('#lib/test-support/app-state.js'));
vi.mock('#lib/core/context.js');
vi.mock('#lib/i18n.js', () => import('#lib/test-support/i18n.js'));
vi.mock('#lib/rooms/room-list.svelte.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('#lib/rooms/room-list.svelte.js')>()),
  useRoomList: () => ({
    get rooms() {
      return spacesInOrder.on ? [managed, unmanaged] : [unmanaged, managed];
    },
  }),
}));

import { core } from '#lib/core/__mocks__/context.js';

import RoomUpgradeSettings from './RoomUpgradeSettings.svelte';

const ROOM_ID = '!room:example.org';
const room = roomView({ room_id: ROOM_ID, name: 'Room' });
const space = (room_id: string): RoomListItemView =>
  roomView({
    room_id,
    room_kind: 'space',
    state: 'joined',
    space_children: [spaceChild({ room_id: ROOM_ID })],
  });
const managed = space('!managed:example.org');
const unmanaged = space('!unmanaged:example.org');
const spacesInOrder = reactiveToggle();

const levels: RoomPowerLevelsView = {
  ban: 50,
  kick: 50,
  redact: 50,
  invite: 0,
  events_default: 0,
  state_default: 50,
  users_default: 0,
  events: {},
  users: {},
  notifications_room: 50,
};

const pendingPermissions: (() => void)[] = [];
Object.assign(core.rpc.members, {
  permissions: vi.fn(
    ({ room_id }: { room_id: string }) =>
      new Promise<RoomPermissionsView>((resolve) => {
        pendingPermissions.push(() => {
          resolve({ can_manage_children: room_id === managed.room_id } as RoomPermissionsView);
        });
      })
  ),
});
Object.assign(core.rpc.rooms, {
  versions: vi.fn(() =>
    Promise.resolve({ default: '11', available: [{ id: '11', stable: true }] })
  ),
  create: vi.fn(() => Promise.resolve('!next:example.org')),
  setTombstone: vi.fn(() => Promise.resolve(null)),
});
Object.assign(core.rpc.spaces, {
  add: vi.fn(() => Promise.resolve(null)),
  remove: vi.fn(() => Promise.resolve(null)),
});

// Room list order follows activity, so it can change while the permission checks are out.
test('a replacement room is filed under the space whose permission was checked', async () => {
  const user = userEvent.setup();
  render(RoomUpgradeSettings, { room, levels, ownPowerLevel: 100, onClose: vi.fn() });

  await user.click(screen.getByRole('button', { name: 'room.upgradeAction' }));
  await user.click(await screen.findByRole('radio', { name: /room\.upgradeModeCustom\b/ }));
  await user.click(screen.getByRole('button', { name: 'room.upgradeActionReplace' }));
  await waitFor(() => {
    expect(pendingPermissions).toHaveLength(2);
  });

  spacesInOrder.on = false;
  for (const resolve of pendingPermissions.splice(0)) resolve();

  await waitFor(() => {
    expect(core.rpc.rooms.create).toHaveBeenCalledOnce();
  });
  expect(core.rpc.rooms.create).toHaveBeenCalledWith(
    expect.objectContaining({ parent_space: managed.room_id })
  );
  expect(core.rpc.spaces.remove).toHaveBeenCalledExactlyOnceWith({
    space_id: managed.room_id,
    room_id: ROOM_ID,
  });
});
