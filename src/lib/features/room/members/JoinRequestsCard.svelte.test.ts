// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';
import type {
  CoreEvent,
  InviteHistoryView,
  MemberView,
  RoomListItemView,
  RoomPermissionsView,
  Rpc,
} from '#src/generated/protocol';
import type { CoreClient } from '#lib/core/client.svelte.js';

vi.mock('#lib/core/context.js');
vi.mock('#lib/rooms/room-list.svelte.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useRoomList: () => roomList,
}));

import { core } from '#lib/core/__mocks__/context.js';
import { RoomList } from '#lib/rooms/room-list.svelte.js';
import JoinRequestsCard from './JoinRequestsCard.svelte';

Object.assign(core.rpc.members, {
  joinRequests: vi.fn<Rpc['members']['joinRequests']>(),
  denyKnock: vi.fn<(params: { room_id: string; user_id: string }) => Promise<null>>(),
});
Object.assign(core.rpc.rooms, { invite: vi.fn<() => Promise<InviteHistoryView>>() });
const roomList = new RoomList(core as unknown as CoreClient);
const room = { room_id: '!room:example.org', display_name: 'Room' } as RoomListItemView;
const permissions = {
  own_power_level: 100,
  can_invite: true,
  can_kick: true,
} as RoomPermissionsView;

function knock(name: string, ts: number): MemberView {
  return {
    user_id: `@${name.toLowerCase()}:example.org`,
    display_name: name,
    real_name: name,
    real_avatar_url: null,
    avatar_url: null,
    power_level: 0,
    membership: 'knock',
    member_ts: ts,
    kicked: false,
    service: false,
  };
}

function requests(...members: MemberView[]) {
  return { rooms: [{ room_id: room.room_id, members, permissions }], failed: false };
}

beforeEach(() => {
  core.rpc.members.joinRequests.mockReset().mockResolvedValue(requests(knock('Alice', 1)));
  core.rpc.rooms.invite.mockReset().mockResolvedValue('not_shared');
  core.rpc.members.denyKnock.mockReset().mockResolvedValue(null);
  roomList.rooms = [room];
});

test('shows the newest three requests with the total count', async () => {
  core.rpc.members.joinRequests.mockResolvedValue(
    requests(knock('Alice', 1), knock('Bob', 2), knock('Cleo', 3), knock('Dan', 4))
  );
  render(JoinRequestsCard, { roomId: room.room_id, onAll: vi.fn() });

  await screen.findByText('Dan');
  expect([...document.querySelectorAll('.name')].map((name) => name.textContent)).toEqual([
    'Dan',
    'Cleo',
    'Bob',
  ]);
  expect(screen.getByRole('heading')).toHaveTextContent('4 Join requests');
});

test('approves a request from the card', async () => {
  render(JoinRequestsCard, { roomId: room.room_id, onAll: vi.fn() });
  await userEvent.click(await screen.findByRole('button', { name: 'Approve Alice' }));

  expect(core.rpc.rooms.invite).toHaveBeenCalledWith({
    room_id: room.room_id,
    user_id: '@alice:example.org',
  });
  await vi.waitFor(() => {
    expect(screen.queryByRole('heading')).toBeNull();
  });
});

test('opens all requests', async () => {
  const onAll = vi.fn();
  render(JoinRequestsCard, { roomId: room.room_id, onAll });
  await userEvent.click(await screen.findByRole('button', { name: 'All requests' }));

  expect(onAll).toHaveBeenCalledOnce();
});

test('stays dismissed until someone new asks to join', async () => {
  let emit!: (event: CoreEvent) => void;
  core.subscribeEvents.mockImplementationOnce((listener) => {
    emit = listener;
    return () => {};
  });
  render(JoinRequestsCard, { roomId: room.room_id, onAll: vi.fn() });
  await userEvent.click(await screen.findByRole('button', { name: 'Dismiss' }));
  expect(screen.queryByText('Alice')).toBeNull();

  const bob = knock('Bob', 2);
  core.rpc.members.joinRequests.mockResolvedValue(requests(knock('Alice', 1), bob));
  emit({ type: 'members_changed', room_id: room.room_id, member: bob });

  await screen.findByText('Bob');
  expect(screen.queryByText('Alice')).toBeNull();
});
