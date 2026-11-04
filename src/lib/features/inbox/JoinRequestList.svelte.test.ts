// @vitest-environment happy-dom

import { render, screen, within } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';
import type {
  MemberView,
  RoomPermissionsView,
  RoomListItemView,
  Rpc,
} from '#src/generated/protocol';
import type { CoreClient } from '#lib/core/client.svelte.js';

vi.mock('#lib/core/context.js');
vi.mock('#lib/rooms/room-list.svelte.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useRoomList: () => roomList,
}));

import { core as baseCore } from '#lib/core/__mocks__/context.js';
import { RoomList } from '#lib/rooms/room-list.svelte.js';
import JoinRequestList from './JoinRequestList.svelte';

const core = baseCore;
Object.assign(core.rpc.members, {
  joinRequests: vi.fn<Rpc['members']['joinRequests']>(),
  list: vi.fn<(params: { room_id: string }) => Promise<MemberView[]>>(),
  permissions: vi.fn<(params: { room_id: string }) => Promise<RoomPermissionsView>>(),
  denyKnock: vi.fn<(params: { room_id: string; user_id: string }) => Promise<null>>(),
});
Object.assign(core.rpc.rooms, { invite: vi.fn<() => Promise<null>>() });
const roomList = new RoomList(core as unknown as CoreClient);
const room = {
  room_id: '!room:example.org',
  name: 'Room',
  state: 'joined',
  join_rule: 'knock',
  display_name: 'Room',
} as RoomListItemView;
const space: RoomListItemView = {
  ...room,
  room_id: '!space:example.org',
  name: 'Space',
  display_name: 'Space',
  room_kind: 'space',
};
const alice: MemberView = {
  user_id: '@alice:example.org',
  display_name: 'Alice',
  real_name: 'Alice',
  real_avatar_url: null,
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
  core.rpc.members.joinRequests.mockReset().mockResolvedValue({
    rooms: [{ room_id: room.room_id, members: [alice], permissions }],
    failed: false,
  });
  core.rpc.members.permissions.mockReset().mockResolvedValue(permissions);
  core.rpc.members.list.mockReset().mockResolvedValue([alice]);
  core.rpc.rooms.invite.mockReset().mockResolvedValue(null);
  core.rpc.members.denyKnock.mockReset().mockResolvedValue(null);
  roomList.rooms = [room];
});

test('approves room requests and denies space requests', async () => {
  roomList.rooms = [room, space];
  core.rpc.members.joinRequests.mockResolvedValue({
    rooms: [room, space].map(({ room_id }) => ({ room_id, members: [alice], permissions })),
    failed: false,
  });
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

test('loads all requests with one RPC on mount and each room-list update', async () => {
  roomList.rooms = [room, space];
  render(JoinRequestList);
  await screen.findByText('Alice');
  expect(core.rpc.members.joinRequests).toHaveBeenCalledExactlyOnceWith({});
  expect(core.rpc.members.permissions).not.toHaveBeenCalled();
  expect(core.rpc.members.list).not.toHaveBeenCalled();

  roomList.rooms = [{ ...room }, { ...space }];
  await vi.waitFor(() => {
    expect(core.rpc.members.joinRequests).toHaveBeenCalledTimes(2);
  });
  expect(core.rpc.members.permissions).not.toHaveBeenCalled();
  expect(core.rpc.members.list).not.toHaveBeenCalled();
});

test('sorts newest requests first and keeps room-list order for equal timestamps', async () => {
  roomList.rooms = [room, space];
  const bob = { ...alice, user_id: '@bob:example.org', display_name: 'Bob', member_ts: 2 };
  core.rpc.members.joinRequests.mockResolvedValue({
    rooms: [
      { room_id: space.room_id, members: [alice], permissions },
      { room_id: room.room_id, members: [alice, bob], permissions },
    ],
    failed: false,
  });
  render(JoinRequestList);
  await screen.findByText('Bob');
  const rows = screen.getAllByRole('listitem');
  expect(rows.map((row) => within(row).getByText(/^(Alice|Bob)$/).textContent)).toEqual([
    'Bob',
    'Alice',
    'Alice',
  ]);
  expect(rows.map((row) => within(row).getByText(/^(Room|Space)$/).textContent)).toEqual([
    'Room',
    'Room',
    'Space',
  ]);
});

test.each([
  { can_invite: true, can_kick: false, approve: true, deny: false },
  { can_invite: false, can_kick: true, approve: false, deny: true },
  { can_invite: true, can_kick: true, own_power_level: 0, approve: true, deny: false },
])(
  'checks invite and kick permissions separately: $approve/$deny',
  async ({ approve, deny, ...overrides }) => {
    core.rpc.members.joinRequests.mockResolvedValue({
      rooms: [
        { room_id: room.room_id, members: [alice], permissions: { ...permissions, ...overrides } },
      ],
      failed: false,
    });
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
  roomList.rooms = [room, space];
  core.rpc.members.joinRequests.mockResolvedValue({
    rooms: [{ room_id: space.room_id, members: [alice], permissions }],
    failed: true,
  });
  render(JoinRequestList);
  expect(await screen.findByRole('alert')).toHaveTextContent('Join requests could not be loaded.');
  expect(screen.getByText('Space')).toBeInTheDocument();
  core.rpc.members.joinRequests.mockResolvedValue({
    rooms: [room, space].map(({ room_id }) => ({ room_id, members: [alice], permissions })),
    failed: false,
  });
  await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
  await screen.findByText('Room');
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

test('refreshes live requests without restoring an answered request from stale state', async () => {
  render(JoinRequestList);
  await screen.findByText('Alice');
  await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
  await screen.findByText('No pending join requests.');

  roomList.rooms = [{ ...room }];
  await vi.waitFor(() => {
    expect(core.rpc.members.joinRequests).toHaveBeenCalledTimes(2);
  });
  expect(screen.queryByText('Alice')).not.toBeInTheDocument();

  core.rpc.members.joinRequests.mockResolvedValue({
    rooms: [{ room_id: room.room_id, members: [{ ...alice, member_ts: 2 }], permissions }],
    failed: false,
  });
  roomList.rooms = [{ ...room }];
  await screen.findByText('Alice');
});

test('shows a failed core call and retries', async () => {
  core.rpc.members.joinRequests.mockRejectedValueOnce(new Error('offline'));
  render(JoinRequestList);
  expect(await screen.findByRole('alert')).toHaveTextContent('Join requests could not be loaded.');
  await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
  await screen.findByText('Alice');
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

test('ignores an older response after the room list changes', async () => {
  const older = Promise.withResolvers<Awaited<ReturnType<Rpc['members']['joinRequests']>>>();
  core.rpc.members.joinRequests.mockReturnValueOnce(older.promise);
  render(JoinRequestList);
  await vi.waitFor(() => {
    expect(core.rpc.members.joinRequests).toHaveBeenCalledTimes(1);
  });
  roomList.rooms = [{ ...room }];
  await screen.findByText('Alice');
  older.resolve({ rooms: [], failed: true });
  await older.promise;
  await vi.waitFor(() => {
    expect(screen.getByText('Alice')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
