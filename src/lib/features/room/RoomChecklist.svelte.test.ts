// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { expect, test, vi } from 'vitest';

import type { RoomListItemView } from '#src/generated/protocol';

const roomList = vi.hoisted(() => ({ rooms: [] as RoomListItemView[] }));
vi.mock('#lib/rooms/room-list.svelte.js', () => ({ useRoomList: () => roomList }));

import RoomChecklist from './RoomChecklist.svelte';

function room(roomId: string, alias: string | null): RoomListItemView {
  return {
    room_id: roomId,
    name: 'General',
    canonical_alias: alias,
    avatar_url: null,
  } as RoomListItemView;
}

test('rooms with the same name are told apart by their address', () => {
  render(RoomChecklist, {
    class: 'targets',
    rooms: [room('!a:one.org', '#general:one.org'), room('!b:two.org', null)],
    selected: [],
    label: (item: RoomListItemView) => item.name ?? item.room_id,
  });

  const [aliased, plain] = screen.getAllByRole('checkbox');
  expect(aliased.querySelector('.alias')).toHaveTextContent('#general:one.org');
  expect(plain.querySelector('.alias')).toBeNull();
});

test('rooms with the same name are told apart by the space they are in', () => {
  roomList.rooms = [
    {
      room_id: '!space:one.org',
      room_kind: 'space',
      state: 'joined',
      is_tombstoned: false,
      display_name: 'Community',
      space_children: [
        { room_id: '!a:one.org', via: [], order: null, origin_server_ts: 1, suggested: false },
      ],
    } as unknown as RoomListItemView,
  ];
  render(RoomChecklist, {
    class: 'targets',
    rooms: [room('!a:one.org', '#general:one.org'), room('!b:two.org', null)],
    selected: [],
    label: (item: RoomListItemView) => item.name ?? item.room_id,
  });

  const [spaced, plain] = screen.getAllByRole('checkbox');
  expect(spaced.querySelector('.alias')).toHaveTextContent('Community · #general:one.org');
  expect(plain.querySelector('.alias')).toBeNull();
  roomList.rooms = [];
});
