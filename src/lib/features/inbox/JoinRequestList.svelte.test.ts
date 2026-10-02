// @vitest-environment happy-dom

import { render, screen, within } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';
import type { MemberView, RoomPermissionsView, RoomSummary } from '#src/generated/protocol';
import type { CoreClient } from '#lib/core/client.svelte.js';

vi.mock('#lib/core/context.js');
vi.mock('#lib/rooms/room-list.svelte.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useRoomList: () => roomList,
}));

import { core as baseCore } from '#lib/core/__mocks__/context.js';
import { RoomList } from '#lib/rooms/room-list.svelte.js';
import JoinRequestList from './JoinRequestList.svelte';

const core = Object.assign(baseCore, {
  roomMembers: vi.fn<(roomId: string) => Promise<MemberView[]>>(),
  roomPermissions: vi.fn<(roomId: string) => Promise<RoomPermissionsView>>(),
  inviteUser: vi.fn<() => Promise<void>>(),
  sendStateEvent: vi.fn<() => Promise<string>>(),
});
const roomList = new RoomList(core as unknown as CoreClient);
const room = {
  room_id: '!room:example.org',
  name: 'Room',
  state: 'joined',
  join_rule: 'knock',
} as RoomSummary;
const space = { ...room, room_id: '!space:example.org', name: 'Space', is_space: true };
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
  core.roomPermissions.mockReset().mockResolvedValue(permissions);
  core.roomMembers.mockReset().mockResolvedValue([alice]);
  core.inviteUser.mockReset().mockResolvedValue(undefined);
  core.sendStateEvent.mockReset().mockResolvedValue('$denied:example.org');
  roomList.rooms = [room];
});

test('approves room requests and denies space requests', async () => {
  roomList.rooms = [room, space];
  render(JoinRequestList);
  const user = userEvent.setup();
  await screen.findAllByText('Alice');
  const rows = screen.getAllByRole('listitem');
  const roomRow = rows.find((row) => row.textContent.includes('Room'));
  const spaceRow = rows.find((row) => row.textContent.includes('Space'));
  if (!roomRow || !spaceRow) throw new Error('Join request rows missing');
  await user.click(within(roomRow).getByRole('button', { name: 'Approve' }));
  await vi.waitFor(() => {
    expect(core.inviteUser).toHaveBeenCalledWith(room.room_id, alice.user_id);
    expect(roomRow).not.toBeInTheDocument();
  });
  await user.click(within(spaceRow).getByRole('button', { name: 'Deny' }));
  await vi.waitFor(() => {
    expect(core.sendStateEvent).toHaveBeenCalledWith(
      space.room_id,
      'm.room.member',
      alice.user_id,
      {
        membership: 'leave',
      }
    );
    expect(screen.getByText('No pending join requests.')).toBeInTheDocument();
  });
});

test('only loads requests in joined knock rooms where we can moderate', async () => {
  roomList.rooms = [
    room,
    { ...space, join_rule: 'knock_restricted' },
    { ...room, room_id: '!invited:example.org', state: 'invited' },
    { ...room, room_id: '!private:example.org', join_rule: 'invite' },
  ];
  core.roomPermissions.mockImplementation((roomId) =>
    Promise.resolve(
      roomId === room.room_id ? { ...permissions, can_invite: false, can_kick: false } : permissions
    )
  );
  render(JoinRequestList);
  await screen.findByText('Alice');
  expect(core.roomMembers).toHaveBeenCalledExactlyOnceWith(space.room_id, ['knock']);
});

test.each([
  { can_invite: true, can_kick: false, approve: true, deny: false },
  { can_invite: false, can_kick: true, approve: false, deny: true },
  { can_invite: true, can_kick: true, own_power_level: 0, approve: true, deny: false },
])(
  'checks invite and kick permissions separately: $approve/$deny',
  async ({ approve, deny, ...overrides }) => {
    core.roomPermissions.mockResolvedValue({ ...permissions, ...overrides });
    render(JoinRequestList);
    await screen.findByText('Alice');
    expect(screen.queryByRole('button', { name: 'Approve' }) !== null).toBe(approve);
    expect(screen.queryByRole('button', { name: 'Deny' }) !== null).toBe(deny);
  }
);

test('keeps a failed request available for retry', async () => {
  core.inviteUser.mockRejectedValueOnce(new Error('forbidden'));
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
  core.roomMembers.mockImplementation((roomId) =>
    roomId === room.room_id ? Promise.reject(new Error('offline')) : Promise.resolve([alice])
  );
  render(JoinRequestList);
  expect(await screen.findByRole('alert')).toHaveTextContent('Join requests could not be loaded.');
  expect(screen.getByText('Space')).toBeInTheDocument();
  core.roomMembers.mockResolvedValue([alice]);
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
    expect(core.roomMembers).toHaveBeenCalledTimes(2);
  });
  expect(screen.queryByText('Alice')).not.toBeInTheDocument();

  core.roomMembers.mockResolvedValue([{ ...alice, member_ts: 2 }]);
  roomList.rooms = [{ ...room }];
  await screen.findByText('Alice');
});
