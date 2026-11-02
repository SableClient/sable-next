// @vitest-environment happy-dom

import { fireEvent, render, screen } from '@testing-library/svelte';
import { expect, test, vi } from 'vitest';

import type { NotificationModeView, RoomListItemView } from '#src/generated/protocol';

vi.mock('#lib/core/context.js');

const rooms: RoomListItemView[] = [];
vi.mock('#lib/rooms/room-list.svelte.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('#lib/rooms/room-list.svelte.js')>()),
  useRoomList: () => ({ rooms, settled: true }),
}));

import { core } from '#lib/core/__mocks__/context.js';

import { spaceNotifications } from '#lib/rooms/space-notifications.svelte.js';

import NotificationRoomModes from './NotificationRoomModes.svelte';

function room(
  roomId: string,
  name: string,
  rule: NotificationModeView | null,
  kind: RoomListItemView['room_kind'] = 'text'
): RoomListItemView {
  return {
    room_id: roomId,
    name,
    display_name: name,
    canonical_alias: null,
    avatar_url: null,
    room_kind: kind,
    state: 'joined',
    space_children: [],
    notification: { room: rule, default: 'mentions' },
  } as unknown as RoomListItemView;
}

test('lists spaces then rooms with their own mode by name and resets one to the default', async () => {
  const setRoomNotificationMode = vi.fn(() => Promise.resolve(null));
  Object.assign(core.rpc.notifications, { setRoomNotificationMode });
  rooms.push(
    room('!quiet', 'Zed room', 'mute'),
    room('!loud', 'Loud room', 'all'),
    room('!plain', 'Plain room', null),
    room('!space', 'Work', 'mute', 'space')
  );

  spaceNotifications.loaded = true;
  render(NotificationRoomModes);

  expect(
    screen.getAllByRole('link').map((link) => link.querySelector('.name')?.textContent)
  ).toEqual(['Work', 'Loud room', 'Zed room']);
  expect(screen.getByText('Space')).toBeInTheDocument();

  expect(screen.getByLabelText('Notifications for Loud room')).toHaveTextContent('All messages');
  expect(screen.queryByText('Plain room')).toBeNull();

  await fireEvent.click(screen.getByRole('button', { name: 'Use the default for Loud room' }));

  expect(setRoomNotificationMode).toHaveBeenCalledWith({ room_id: '!loud', mode: null });
});
