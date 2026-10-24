// @vitest-environment happy-dom

import { render, screen, within } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import type { MemberView, RoomPermissionsView, RoomListItemView } from '#src/generated/protocol';

vi.mock('#lib/core/context.js');
vi.mock('#lib/rooms/room-list.svelte.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useRoomList: () => roomList,
}));

import { core as baseCore } from '#lib/core/__mocks__/context.js';
import { RoomList } from '#lib/rooms/room-list.svelte.js';
import { FakeRuntime, roomsView } from '#lib/test-support/fake-runtime.js';
import JoinRequestList from './JoinRequestList.svelte';

const core = baseCore;
Object.assign(core.rpc.members, {
  list: vi.fn<(params: { room_id: string }) => Promise<MemberView[]>>(),
  permissions: vi.fn<(params: { room_id: string }) => Promise<RoomPermissionsView>>(),
  denyKnock: vi.fn<(params: { room_id: string; user_id: string }) => Promise<null>>(),
});
Object.assign(core.rpc.rooms, { invite: vi.fn<() => Promise<null>>() });
const runtime = new FakeRuntime({ rooms: roomsView([]) });
const roomList = new RoomList(() => runtime.client());
const setRooms = (rooms: RoomListItemView[]) => {
  runtime.set('rooms', roomsView(rooms));
};

beforeAll(() => roomList.start());
afterAll(() => {
  roomList.stop();
});
const room = {
  room_id: '!room:example.org',
  name: 'Room',
  state: 'joined',
  join_rule: 'knock',
} as RoomListItemView;
const space: RoomListItemView = {
  ...room,
  room_id: '!space:example.org',
  name: 'Space',
  room_kind: 'space',
};
const alice: MemberView = {
  user_id: '@alice:example.org',
  display_name: 'Alice',
  avatar_url: null,
  power_level: 0,
  membership: 'knock',
  member_ts: 1,
  kicked: false,
  service: false,
};
const permissions = {
  own_power_level: 100,
  can_invite: true,
  can_kick: true,
} as RoomPermissionsView;

beforeEach(() => {
  core.rpc.members.permissions.mockReset().mockResolvedValue(permissions);
  core.rpc.members.list.mockReset().mockResolvedValue([alice]);
  core.rpc.rooms.invite.mockReset().mockResolvedValue(null);
  core.rpc.members.denyKnock.mockReset().mockResolvedValue(null);
  setRooms([room]);
});

test('approves room requests and denies space requests', async () => {
  setRooms([room, space]);
  render(JoinRequestList);
  const user = userEvent.setup();
  await screen.findAllByText('Alice');
  const rows = screen.getAllByRole('listitem');
  const roomRow = rows.find((row) => row.textContent.includes('Room'));
  const spaceRow = rows.find((row) => row.textContent.includes('Space'));
  if (!roomRow || !spaceRow) throw new Error('Join request rows missing');
  await user.click(within(roomRow).getByRole('button', { name: 'Approve' }));
  await vi.waitFor(() => {
    expect(core.rpc.rooms.invite).toHaveBeenCalledWith({
      room_id: room.room_id,
      user_id: alice.user_id,
    });
    expect(roomRow).not.toBeInTheDocument();
  });
  await user.click(within(spaceRow).getByRole('button', { name: 'Deny' }));
  await vi.waitFor(() => {
    expect(core.rpc.members.denyKnock).toHaveBeenCalledWith({
      room_id: space.room_id,
      user_id: alice.user_id,
    });
    expect(screen.getByText('No pending join requests.')).toBeInTheDocument();
  });
});

test('only loads requests in joined knock rooms where we can moderate', async () => {
  setRooms([
    room,
    { ...space, join_rule: 'knock_restricted' },
    { ...room, room_id: '!invited:example.org', state: 'invited' },
    { ...room, room_id: '!private:example.org', join_rule: 'invite' },
  ]);
  core.rpc.members.permissions.mockImplementation(({ room_id }) =>
    Promise.resolve(
      room_id === room.room_id
        ? { ...permissions, can_invite: false, can_kick: false }
        : permissions
    )
  );
  render(JoinRequestList);
  await screen.findByText('Alice');
  expect(core.rpc.members.list).toHaveBeenCalledExactlyOnceWith({
    room_id: space.room_id,
    memberships: ['knock'],
  });
});

test.each([
  { can_invite: true, can_kick: false, approve: true, deny: false },
  { can_invite: false, can_kick: true, approve: false, deny: true },
  { can_invite: true, can_kick: true, own_power_level: 0, approve: true, deny: false },
])(
  'checks invite and kick permissions separately: $approve/$deny',
  async ({ approve, deny, ...overrides }) => {
    core.rpc.members.permissions.mockResolvedValue({ ...permissions, ...overrides });
    render(JoinRequestList);
    await screen.findByText('Alice');
    expect(screen.queryByRole('button', { name: 'Approve' }) !== null).toBe(approve);
    expect(screen.queryByRole('button', { name: 'Deny' }) !== null).toBe(deny);
  }
);

test('keeps a failed request available for retry', async () => {
  core.rpc.rooms.invite.mockRejectedValueOnce(new Error('forbidden'));
  render(JoinRequestList);
  await screen.findByText('Alice');
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Approve' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(
    'The join request could not be updated. Try again.'
  );
  expect(screen.getByText('Alice')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Approve' }));
  await screen.findByText('No pending join requests.');
});

test('shows requests from other rooms when one fails to load and retries', async () => {
  setRooms([room, space]);
  core.rpc.members.list.mockImplementation(({ room_id }) =>
    room_id === room.room_id ? Promise.reject(new Error('offline')) : Promise.resolve([alice])
  );
  render(JoinRequestList);
  expect(await screen.findByRole('alert')).toHaveTextContent('Join requests could not be loaded.');
  expect(screen.getByText('Space')).toBeInTheDocument();
  core.rpc.members.list.mockResolvedValue([alice]);
  await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
  await screen.findByText('Room');
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

test('refreshes live requests without restoring an answered request from stale state', async () => {
  render(JoinRequestList);
  await screen.findByText('Alice');
  await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
  await screen.findByText('No pending join requests.');

  setRooms([{ ...room }]);
  await vi.waitFor(() => {
    expect(core.rpc.members.list).toHaveBeenCalledTimes(2);
  });
  expect(screen.queryByText('Alice')).not.toBeInTheDocument();

  core.rpc.members.list.mockResolvedValue([{ ...alice, member_ts: 2 }]);
  setRooms([{ ...room }]);
  await screen.findByText('Alice');
});
