// @vitest-environment happy-dom

import { fireEvent, render, screen } from '@testing-library/svelte';
import { expect, test, vi } from 'vitest';

import type { NotificationModeView, RoomListItemView } from '#src/generated/protocol';

vi.mock('#lib/core/context.js');

const rooms: RoomListItemView[] = [];
vi.mock('#lib/rooms/room-list.svelte.js', () => ({ useRoomList: () => ({ rooms }) }));

import { core } from '#lib/core/__mocks__/context.js';

import NotificationRoomModes from './NotificationRoomModes.svelte';

function room(roomId: string, name: string, rule: NotificationModeView | null): RoomListItemView {
  return {
    room_id: roomId,
    name,
    canonical_alias: null,
    room_kind: 'text',
    state: 'joined',
    space_children: [],
    notification: { room: rule, default: 'mentions' },
  } as unknown as RoomListItemView;
}

test('lists rooms with their own mode and resets one to the default', async () => {
  const setRoomNotificationMode = vi.fn(() => Promise.resolve(null));
  Object.assign(core.rpc.notifications, { setRoomNotificationMode });
  rooms.push(room('!loud', 'Loud room', 'all'), room('!plain', 'Plain room', null));

  render(NotificationRoomModes);

  expect(screen.getByLabelText('Notifications for Loud room')).toHaveTextContent('All messages');
  expect(screen.queryByText('Plain room')).toBeNull();

  await fireEvent.click(screen.getByRole('button', { name: 'Use the default for Loud room' }));

  expect(setRoomNotificationMode).toHaveBeenCalledWith({ room_id: '!loud', mode: null });
});
