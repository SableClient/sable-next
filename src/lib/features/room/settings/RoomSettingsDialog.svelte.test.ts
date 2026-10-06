// @vitest-environment happy-dom

import { render, screen, type RenderResult } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { tick } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

import type { RoomPermissionsView, RoomSummary } from '#src/generated/protocol';

vi.mock('#lib/core/context.js');
vi.mock('#lib/rooms/room-list.svelte.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('#lib/rooms/room-list.svelte.js')>()),
  useRoomList: () => ({ rooms: [], labelFor: (id: string) => id }),
}));

import { core as baseCore } from '#lib/core/__mocks__/context.js';

const core = Object.assign(baseCore, {
  roomPowerLevels: vi.fn(),
  roomStateEventsRaw: vi.fn().mockResolvedValue([]),
  roomAliases: vi.fn(),
  roomDirectoryVisibility: vi.fn(),
  roomHasSpaceParent: vi.fn(),
});
vi.mock('#lib/i18n.js', () => import('#lib/test-support/i18n.js'));

import RoomSettingsDialog from './RoomSettingsDialog.svelte';

const room: RoomSummary = {
  room_id: '!room:example.org',
  canonical_alias: null,
  name: 'Restricted room',
  topic: null,
  avatar_url: null,
  is_direct: false,
  direct_targets: [],
  join_rule: 'restricted',
  tags: [],
  state: 'joined',
  encrypted: null,
  is_space: false,
  is_tombstoned: false,
  is_voice: false,
  call_participants: [],
  room_type: null,
  supports_knock: true,
  supports_restricted: true,
  supports_knock_restricted: true,
  space_children: [],
  unread: 0,
  notifying: 0,
  highlight: 0,
  marked_unread: false,
  latest_event: null,
};

function permissions(canChangeJoinRule: boolean): RoomPermissionsView {
  return {
    own_power_level: canChangeJoinRule ? 100 : 0,
    can_post: true,
    can_react: true,
    can_redact_own: true,
    can_redact_others: false,
    can_invite: false,
    can_kick: false,
    can_ban: false,
    can_change_settings: false,
    can_pin: false,
    can_change_join_rule: canChangeJoinRule,
    can_change_power_levels: false,
    can_manage_children: false,
  };
}

async function setup(
  canChangeJoinRule: boolean,
  hasSpaceParent = false,
  isSpace = false
): Promise<RenderResult<typeof RoomSettingsDialog>> {
  core.roomPermissions.mockResolvedValue(permissions(canChangeJoinRule));
  core.roomPowerLevels.mockResolvedValue({
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
  });
  core.roomStateEvent.mockResolvedValue(null);
  core.roomAliases.mockResolvedValue([]);
  core.roomDirectoryVisibility.mockResolvedValue(false);
  core.roomHasSpaceParent.mockResolvedValue(hasSpaceParent);
  const instance = render(RoomSettingsDialog, {
    props: {
      open: true,
      room: { ...room, is_space: isSpace },
      onOpenChange: () => {},
    },
  });
  await tick();
  await tick();
  return instance;
}

afterEach(() => {
  vi.clearAllMocks();
});

test('does not offer to replace an unsupported join rule without permission', async () => {
  await setup(false);

  expect(screen.queryByText(/room\.settingsJoinRuleUnsettable/)).not.toBeInTheDocument();
});

test('warns authorized users before replacing an unsupported join rule', async () => {
  await setup(true);

  expect(await screen.findByText(/room\.settingsJoinRuleUnsettable/)).toBeInTheDocument();
});

test('offers space-based rules to a room in a space', async () => {
  await setup(true, true);

  expect(
    await screen.findByRole('radio', { name: /room\.settingsJoinRuleRestricted/ })
  ).toBeInTheDocument();
  expect(
    screen.getByRole('radio', { name: /room\.settingsJoinRuleKnockRestricted/ })
  ).toBeInTheDocument();
  expect(screen.queryByText(/room\.settingsJoinRuleUnsettable/)).not.toBeInTheDocument();
});

test.each([false, true])('non-admins can inspect and copy data (space: %s)', async (isSpace) => {
  const avatarEvent = {
    type: 'm.room.avatar',
    state_key: '',
    content: { url: 'mxc://example.org/room-avatar' },
  };
  core.roomStateEventsRaw.mockImplementation((_roomId: string, type: string) => {
    if (type === 'm.space.child') return Promise.reject(new Error('state unavailable'));
    return Promise.resolve(type === 'm.room.avatar' ? [avatarEvent] : []);
  });
  const user = userEvent.setup();
  await setup(false, false, isSpace);
  const click = (label: string) =>
    user.click(screen.getByRole('button', { name: new RegExp(label.replace('.', '\\.')) }));

  await click('room.settingsDeveloper');
  expect(
    screen.getByRole('heading', {
      name: isSpace ? 'room.devSpaceDataTitle' : 'room.devRoomDataTitle',
    })
  ).toBeInTheDocument();
  expect(screen.queryByText(/room\.devSend/)).not.toBeInTheDocument();
  await click('room.devDataLoad');
  const field = await screen.findByRole('textbox', { name: 'room.devDataJson' });
  const data: unknown = JSON.parse((field as HTMLTextAreaElement).value);
  expect(field).toHaveAttribute('readonly');
  expect(data).toMatchObject({
    room: { room_id: room.room_id, is_space: isSpace, avatar_url: null },
    cached_state: {
      'm.room.avatar': { events: [avatarEvent] },
      'm.space.child': { error: 'state unavailable' },
    },
  });
  expect(core.roomStateEventsRaw).toHaveBeenCalledWith(room.room_id, 'm.space.parent', null);
  await click('room.devDataCopy');
  expect(await navigator.clipboard.readText()).toBe((field as HTMLTextAreaElement).value);
});

test('members who cannot edit packs still see the emoji section', async () => {
  await setup(false);

  expect(screen.getByRole('button', { name: /room\.settingsEmojis/ })).toBeInTheDocument();
});
