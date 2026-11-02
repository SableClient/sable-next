// @vitest-environment happy-dom

import { render, screen, within } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';

import { CoreError } from '#src/transport';
import type {
  MemberView,
  PowerLevelTagView,
  RoomPermissionsView,
  RoomListItemView,
  UserDirectoryEntryView,
} from '#src/generated/protocol';

vi.mock('#lib/core/context.js');

import { core as baseCore } from '#lib/core/__mocks__/context.js';

const searchUserDirectory =
  vi.fn<() => Promise<{ limited: boolean; results: UserDirectoryEntryView[] }>>();
const core = baseCore;
Object.assign(core.rpc.members, {
  list: vi.fn<() => Promise<MemberView[]>>(),
  kick: vi.fn<(params: object) => Promise<null>>(),
  ban: vi.fn<(params: object) => Promise<null>>(),
  unban: vi.fn<() => Promise<null>>(),
  setUserPowerLevel: vi.fn<() => Promise<null>>(),
  powerLevelTags: vi.fn<() => Promise<Record<string, PowerLevelTagView>>>(() =>
    Promise.resolve({})
  ),
});
Object.assign(core.rpc.rooms, { invite: vi.fn<(params: object) => Promise<null>>() });
Object.assign(core.rpc.room_state, { sendEvent: vi.fn<() => Promise<string>>() });
Object.assign(core.rpc.account, { searchUserDirectory });

vi.mock('#lib/rooms/presence.svelte.js', () => ({
  usePresenceStore: () => ({ get: () => null, peek: () => null }),
}));

import RoomMembersSettings from './RoomMembersSettings.svelte';

const alice: MemberView = {
  user_id: '@alice:example.org',
  display_name: 'Alice',
  real_name: 'Alice',
  real_avatar_url: null,
  avatar_url: null,
  power_level: 0,
  membership: 'join',
  member_ts: null,
  kicked: false,
  service: false,
};

const room: RoomListItemView = { room_id: '!room:example.org' } as RoomListItemView;

const permissions: RoomPermissionsView = {
  own_power_level: 100,
  can_post: true,
  can_react: true,
  can_redact_own: true,
  can_redact_others: false,
  can_invite: false,
  can_kick: true,
  can_ban: true,
  can_change_settings: false,
  can_pin: false,
  can_change_join_rule: false,
  can_change_power_levels: false,
  can_manage_children: false,
};

async function renderMembers(roomPermissions: RoomPermissionsView = permissions) {
  render(RoomMembersSettings, { room, permissions: roomPermissions });
  await screen.findByText('Alice');
  return userEvent.setup();
}

const search = () => screen.getByRole('searchbox');
const invites = () => screen.queryByRole('region', { name: 'Invite people' });

test('offers approval and denial for join requests', async () => {
  const requester: MemberView = { ...alice, membership: 'knock' };
  core.rpc.members.list.mockResolvedValue([requester]);
  render(RoomMembersSettings, { room, permissions: { ...permissions, can_invite: true } });
  const user = userEvent.setup();

  await user.click(screen.getByRole('radio', { name: 'Requests' }));
  await screen.findByText('Alice');
  expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Deny' })).toBeInTheDocument();
  expect(core.rpc.members.list).toHaveBeenLastCalledWith({
    room_id: '!room:example.org',
    memberships: ['knock'],
  });
});

test.each(['Approve', 'Deny'])('answers a join request with %s', async (action) => {
  core.rpc.members.list.mockResolvedValue([{ ...alice, membership: 'knock' }]);
  core.rpc.rooms.invite.mockResolvedValue(null);
  core.rpc.members.kick.mockResolvedValue(null);
  render(RoomMembersSettings, { room, permissions: { ...permissions, can_invite: true } });
  const user = userEvent.setup();
  await user.click(screen.getByRole('radio', { name: 'Requests' }));
  await screen.findByText('Alice');
  await user.click(screen.getByRole('button', { name: action }));

  await vi.waitFor(() => {
    if (action === 'Approve')
      expect(core.rpc.rooms.invite).toHaveBeenCalledWith({
        room_id: room.room_id,
        user_id: alice.user_id,
      });
    else
      expect(core.rpc.members.kick).toHaveBeenCalledWith({
        room_id: room.room_id,
        user_id: alice.user_id,
        reason: null,
      });
    expect(screen.queryByText('Alice')).not.toBeInTheDocument();
  });
});

test('collects an optional reason before kicking a member', async () => {
  core.rpc.members.list.mockResolvedValue([alice]);
  core.rpc.members.kick.mockResolvedValue(null);
  const user = await renderMembers();

  await user.click(screen.getByRole('button', { name: 'Remove from room' }));
  const dialog = await screen.findByRole('dialog');
  await user.type(
    within(dialog).getByRole('textbox', { name: 'Reason (optional, shown to the room)' }),
    'spamming links'
  );
  await user.click(within(dialog).getByRole('button', { name: 'Remove from room' }));

  await vi.waitFor(() => {
    expect(core.rpc.members.kick).toHaveBeenCalledWith({
      room_id: '!room:example.org',
      user_id: '@alice:example.org',
      reason: 'spamming links',
    });
  });
});

test('sends no reason when the moderation reason is left blank', async () => {
  core.rpc.members.list.mockResolvedValue([alice]);
  core.rpc.members.ban.mockResolvedValue(null);
  const user = await renderMembers();

  await user.click(screen.getByRole('button', { name: 'Ban from room' }));
  const dialog = await screen.findByRole('dialog');
  await user.click(within(dialog).getByRole('button', { name: 'Ban from room' }));

  await vi.waitFor(() => {
    expect(core.rpc.members.ban).toHaveBeenCalledWith({
      room_id: '!room:example.org',
      user_id: '@alice:example.org',
      reason: null,
    });
  });
});

test('searches the directory and invites from the members list', async () => {
  core.rpc.members.list.mockResolvedValue([alice]);
  searchUserDirectory.mockResolvedValue({
    limited: false,
    results: [
      {
        user_id: '@alice:example.org',
        display_name: 'Alice',
        avatar_url: null,
        real_name: 'Alice',
        real_avatar_url: null,
      },
      {
        user_id: '@bob:example.org',
        display_name: 'Bob',
        avatar_url: null,
        real_name: 'Bob',
        real_avatar_url: null,
      },
    ],
  });
  core.rpc.rooms.invite.mockResolvedValue(null);
  const user = await renderMembers({ ...permissions, can_invite: true });

  await user.type(search(), 'bo');

  await vi.waitFor(() => {
    expect(searchUserDirectory).toHaveBeenCalledWith({ term: 'bo', limit: 10 });
    expect(invites()).toHaveTextContent('@bob:example.org');
  });
  const section = within(invites() ?? document.body);
  expect(section.getAllByRole('button', { name: 'Invite' })).toHaveLength(1);
  expect(invites()).not.toHaveTextContent('@alice:example.org');

  await user.click(section.getByRole('button', { name: 'Invite' }));
  await vi.waitFor(() => {
    expect(core.rpc.rooms.invite).toHaveBeenCalledWith({
      room_id: '!room:example.org',
      user_id: '@bob:example.org',
    });
    expect(section.queryByRole('button', { name: 'Invite' })).not.toBeInTheDocument();
    expect(section.getByText('Invited')).toBeInTheDocument();
  });
});

test('offers a typed user id the directory does not know', async () => {
  core.rpc.members.list.mockResolvedValue([alice]);
  searchUserDirectory.mockResolvedValue({ limited: false, results: [] });
  const user = await renderMembers({ ...permissions, can_invite: true });

  await user.type(search(), '@carol:elsewhere.org');

  expect(invites()).toHaveTextContent('@carol:elsewhere.org');
});

test('offers no invite without the permission', async () => {
  core.rpc.members.list.mockResolvedValue([alice]);
  const user = await renderMembers();

  expect(search()).toHaveAccessibleName('Search members');
  await user.type(search(), '@carol:elsewhere.org');
  expect(invites()).not.toBeInTheDocument();
});

test('keeps a changed power level when the reload still returns the old one', async () => {
  const bob: MemberView = { ...alice, user_id: '@bob:example.org', display_name: 'Bob' };
  core.rpc.members.list.mockResolvedValue([alice, bob]);
  core.rpc.members.setUserPowerLevel.mockResolvedValue(null);
  const user = await renderMembers({ ...permissions, can_change_power_levels: true });
  const names = () =>
    Array.from(document.querySelectorAll('.setting-row'), (row) =>
      row.textContent.includes('Bob') ? 'Bob' : 'Alice'
    );
  expect(names()).toEqual(['Alice', 'Bob']);

  const [, bobRole] = screen.getAllByRole('combobox', { name: 'Change role' });
  await user.click(bobRole);
  await user.click(await screen.findByRole('option', { name: /Moderator/ }));

  await vi.waitFor(() => {
    expect(core.rpc.members.setUserPowerLevel).toHaveBeenCalledWith({
      room_id: '!room:example.org',
      user_id: '@bob:example.org',
      power_level: 50,
    });
  });
  await vi.waitFor(() => {
    expect(names()).toEqual(['Bob', 'Alice']);
  });
});

test('offers the roles created in the room alongside the default ones', async () => {
  const bob: MemberView = { ...alice, user_id: '@bob:example.org', display_name: 'Bob' };
  core.rpc.members.list.mockResolvedValue([alice, bob]);
  core.rpc.members.setUserPowerLevel.mockResolvedValue(null);
  core.rpc.members.powerLevelTags.mockResolvedValue({
    '75': { name: 'Helper', color: null, icon: null },
  });
  const user = await renderMembers({ ...permissions, can_change_power_levels: true });

  const [, bobRole] = screen.getAllByRole('combobox', { name: 'Change role' });
  await user.click(bobRole);
  await user.click(await screen.findByRole('option', { name: /Helper/ }));

  await vi.waitFor(() => {
    expect(core.rpc.members.setUserPowerLevel).toHaveBeenCalledWith({
      room_id: '!room:example.org',
      user_id: '@bob:example.org',
      power_level: 75,
    });
  });
});

test('offers no role above your own and asks before lowering your own', async () => {
  const me: MemberView = {
    ...alice,
    user_id: '@me:example.org',
    display_name: 'Me',
    real_name: 'Me',
    real_avatar_url: null,
    power_level: 50,
  };
  core.session = { user_id: '@me:example.org' };
  core.rpc.members.list.mockResolvedValue([alice, me]);
  core.rpc.members.setUserPowerLevel.mockReset().mockResolvedValue(null);
  const user = await renderMembers({
    ...permissions,
    own_power_level: 50,
    can_change_power_levels: true,
  });
  const roleOf = (name: string) =>
    within(screen.getByText(name).closest('li') ?? document.body).getByRole('combobox', {
      name: 'Change role',
    });

  await user.click(roleOf('Alice'));
  expect(await screen.findByRole('option', { name: /Moderator/ })).toBeInTheDocument();
  expect(screen.queryByRole('option', { name: /Admin/ })).toBeNull();
  await user.keyboard('{Escape}');

  await user.click(roleOf('Me'));
  await user.click(await screen.findByRole('option', { name: /Member/ }));
  const dialog = await screen.findByRole('dialog', { name: 'Give up your own role?' });
  expect(core.rpc.members.setUserPowerLevel).not.toHaveBeenCalled();

  await user.click(within(dialog).getByRole('button', { name: 'Lower my role' }));
  await vi.waitFor(() => {
    expect(core.rpc.members.setUserPowerLevel).toHaveBeenCalledWith({
      room_id: '!room:example.org',
      user_id: '@me:example.org',
      power_level: 0,
    });
  });
  core.session = null;
});

test('refreshes the list and says the server refused when a kick is denied', async () => {
  core.rpc.members.list.mockResolvedValueOnce([alice]).mockResolvedValue([]);
  core.rpc.members.kick.mockRejectedValue(new CoreError({ code: 'denied' }));
  const user = await renderMembers();

  await user.click(screen.getByRole('button', { name: 'Remove from room' }));
  await user.click(
    within(await screen.findByRole('dialog')).getByRole('button', { name: 'Remove from room' })
  );

  expect(await screen.findByRole('alert')).toHaveTextContent('The server refused this');
  expect(core.rpc.members.list).toHaveBeenCalledTimes(2);
  expect(screen.queryByText('Alice')).not.toBeInTheDocument();
});
