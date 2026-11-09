// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';

import type {
  RoomPermissionsView,
  RoomPowerLevelsView,
  RoomListItemView,
} from '#src/generated/protocol';

vi.mock('#lib/core/context.js');
vi.mock('#lib/rooms/room-list.svelte.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('#lib/rooms/room-list.svelte.js')>()),
  useRoomList: () => ({ rooms: [], labelFor: (id: string) => id }),
}));
vi.mock('#lib/i18n.js', () => import('#lib/test-support/i18n.js'));

import { core as baseCore } from '#lib/core/__mocks__/context.js';
import { withCounts } from '#lib/rooms/summary-fixtures.js';

import RoomGeneralSettings from './RoomGeneralSettings.svelte';

const spaces = Object.assign(baseCore.rpc.spaces, {
  roomHasSpaceParent: vi.fn<() => Promise<boolean>>(),
});
const core = baseCore;
Object.assign(core.rpc.rooms, {
  aliases: vi.fn<() => Promise<string[]>>(),
  directoryVisibility: vi.fn<() => Promise<boolean>>(),
});
Object.assign(core.rpc.room_state, {
  eventsRaw: vi.fn<() => Promise<unknown[]>>().mockResolvedValue([]),
  setJoinRule: vi.fn<() => Promise<void>>(),
});

const room: RoomListItemView = withCounts({
  room_id: '!room:example.org',
  canonical_alias: null,
  name: 'Example room',
  topic: null,
  topic_html: null,
  avatar_url: null,
  is_direct: false,
  direct_targets: [],
  join_rule: 'invite',
  tags: [],
  state: 'joined',
  encrypted: null,
  is_tombstoned: false,
  call_participants: [],
  screen_sharers: [],
  room_kind: 'text',
  supports_knock: true,
  supports_restricted: false,
  supports_knock_restricted: false,
  space_children: [],
  bridge: null,
  unread: 0,
  notifying: 0,
  highlight: 0,
  marked_unread: false,
  latest_event: null,
});

const permissions: RoomPermissionsView = {
  own_power_level: 50,
  can_post: true,
  can_react: true,
  can_redact_own: true,
  can_redact_others: false,
  can_invite: false,
  can_kick: false,
  can_ban: false,
  can_change_settings: false,
  can_pin: false,
  can_change_join_rule: true,
  can_change_power_levels: false,
  can_manage_children: false,
};

const levels: RoomPowerLevelsView = {
  ban: 50,
  kick: 50,
  redact: 50,
  invite: 0,
  events_default: 0,
  state_default: 50,
  users_default: 0,
  events: {
    'm.room.avatar': 100,
    'm.room.name': 100,
    'm.room.topic': 100,
  },
  users: {},
  notifications_room: 50,
};

afterEach(() => {
  vi.clearAllMocks();
});

test('saves an access change with join-rule permission alone', async () => {
  spaces.roomHasSpaceParent.mockResolvedValue(false);
  core.rpc.rooms.aliases.mockResolvedValue([]);
  core.rpc.rooms.directoryVisibility.mockResolvedValue(false);
  core.rpc.room_state.setJoinRule.mockResolvedValue(null);
  const user = userEvent.setup();
  render(RoomGeneralSettings, { room, permissions, levels, onClose: () => {} });

  await user.click(await screen.findByRole('radio', { name: /room\.settingsJoinRulePublic/ }));
  await user.click(screen.getByRole('button', { name: 'common.save' }));

  await vi.waitFor(() => {
    expect(core.rpc.room_state.setJoinRule).toHaveBeenCalledWith({
      room_id: '!room:example.org',
      rule: 'public',
    });
  });
});

test('an unsaved change raises the save bar, and reset discards it', async () => {
  spaces.roomHasSpaceParent.mockResolvedValue(false);
  core.rpc.rooms.aliases.mockResolvedValue([]);
  core.rpc.rooms.directoryVisibility.mockResolvedValue(false);
  const user = userEvent.setup();
  render(RoomGeneralSettings, { room, permissions, levels, onClose: () => {} });

  expect(screen.queryByText('common.unsavedChangesNotice')).not.toBeInTheDocument();
  await user.click(await screen.findByRole('radio', { name: /room\.settingsJoinRulePublic/ }));
  expect(screen.getByText('common.unsavedChangesNotice').closest('.save-bar')).toHaveClass(
    'pending'
  );

  await user.click(screen.getByRole('button', { name: 'common.reset' }));
  expect(screen.queryByText('common.unsavedChangesNotice')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'common.save' })).toBeDisabled();
  expect(core.rpc.room_state.setJoinRule).not.toHaveBeenCalled();
});
