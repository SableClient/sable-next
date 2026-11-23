// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';

import type { RoomListItemView, RoomPowerLevelsView } from '#src/generated/protocol';

const goto = vi.hoisted(() => vi.fn());
const listed = vi.hoisted(() => ({ rooms: [] as RoomListItemView[] }));

vi.mock('$app/navigation', () => ({ goto }));
vi.mock('#lib/core/context.js');
vi.mock('#lib/i18n.js', () => import('#lib/test-support/i18n.js'));
vi.mock('#lib/rooms/room-list.svelte.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('#lib/rooms/room-list.svelte.js')>()),
  useRoomList: () => ({
    get rooms() {
      return listed.rooms;
    },
    byId: (id: string) => (id === '!joined:home.example' ? { room_id: id } : undefined),
    labelFor: (id: string) => id,
  }),
}));

import { core as baseCore } from '#lib/core/__mocks__/context.js';
import { spaceChild } from '#lib/test-support/room-views.js';

import RoomSpacesSettings from './RoomSpacesSettings.svelte';

const core = baseCore;
Object.assign(baseCore.rpc.room_state, {
  eventsRaw: vi.fn<(...args: never[]) => Promise<unknown[]>>(() =>
    Promise.resolve([
      {
        state_key: '!joined:home.example',
        content: { via: ['home.example'], canonical: true },
      },
      { state_key: '!other:far.example', content: { via: ['far.example'] } },
    ])
  ),
});
Object.assign(baseCore.rpc.room_state, {
  sendEvent: vi.fn<(...args: never[]) => Promise<string>>(() => Promise.resolve('$sent')),
});
Object.assign(baseCore.rpc.rooms, {
  join: vi.fn<(...args: never[]) => Promise<string>>(() => Promise.resolve('!other:far.example')),
});

const room = { room_id: '!room:home.example' } as RoomListItemView;

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

afterEach(() => {
  vi.clearAllMocks();
  listed.rooms = [];
});

test('a joined parent space opens', async () => {
  const user = userEvent.setup();
  render(RoomSpacesSettings, { room, levels, ownPowerLevel: 0 });

  await user.click(await screen.findByRole('button', { name: 'room.spaceOpen' }));

  expect(goto).toHaveBeenCalledOnce();
});

test('an unjoined parent space is joined through its via servers, then opened', async () => {
  const user = userEvent.setup();
  render(RoomSpacesSettings, { room, levels, ownPowerLevel: 0 });

  await user.click(await screen.findByRole('button', { name: 'common.join' }));

  expect(core.rpc.rooms.join).toHaveBeenCalledWith({
    address: '!other:far.example',
    via: ['far.example'],
  });
  expect(goto).toHaveBeenCalledOnce();
});

test('making another parent canonical unsets the previous one', async () => {
  const user = userEvent.setup();
  render(RoomSpacesSettings, { room, levels, ownPowerLevel: 100 });

  await user.click(await screen.findByRole('button', { name: 'room.spaceMakeCanonical' }));

  expect(core.rpc.room_state.sendEvent.mock.calls).toEqual([
    [
      {
        room_id: '!room:home.example',
        event_type: 'm.space.parent',
        state_key: '!other:far.example',
        content: { via: ['far.example'], canonical: true },
      },
    ],
    [
      {
        room_id: '!room:home.example',
        event_type: 'm.space.parent',
        state_key: '!joined:home.example',
        content: { via: ['home.example'] },
      },
    ],
  ]);
});

test('without the power to change parents there is no way to pick the canonical one', async () => {
  render(RoomSpacesSettings, { room, levels, ownPowerLevel: 0 });

  await screen.findByText('room.spaceCanonical');

  expect(screen.queryByRole('button', { name: 'room.spaceMakeCanonical' })).toBeNull();
});

test('a space that delisted the room is not offered as a parent, a private filing is', async () => {
  const space = (roomId: string, child: { via: string[]; private: boolean }) =>
    ({
      room_id: roomId,
      room_kind: 'space',
      space_children: [spaceChild({ ...child, room_id: room.room_id })],
    }) as unknown as RoomListItemView;
  listed.rooms = [
    space('!delisted:home.example', { via: [], private: false }),
    space('!private:home.example', { via: [], private: true }),
  ];
  render(RoomSpacesSettings, { room, levels, ownPowerLevel: 0 });

  expect(await screen.findByText('!private:home.example')).toBeInTheDocument();
  expect(screen.queryByText('!delisted:home.example')).toBeNull();
});
