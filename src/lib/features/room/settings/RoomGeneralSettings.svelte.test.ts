// @vitest-environment happy-dom

import { mount, tick, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

import type {
  RoomPermissionsView,
  RoomPowerLevelsView,
  RoomSummary,
} from '#src/generated/protocol';

vi.mock('#lib/core/context.js');
vi.mock('#lib/i18n.js', () => ({
  i18n: {
    subscribe(run: (value: { t: (key: string) => string }) => void) {
      run({ t: (key) => key });
      return () => {};
    },
  },
}));

import { core as baseCore } from '#lib/core/__mocks__/context.js';

import RoomGeneralSettings from './RoomGeneralSettings.svelte';

const core = Object.assign(baseCore, {
  roomHasSpaceParent: vi.fn<() => Promise<boolean>>(),
  roomAliases: vi.fn<() => Promise<string[]>>(),
  roomDirectoryVisibility: vi.fn<() => Promise<boolean>>(),
  setRoomJoinRule: vi.fn<() => Promise<void>>(),
});

const room: RoomSummary = {
  room_id: '!room:example.org',
  canonical_alias: null,
  name: 'Example room',
  topic: null,
  avatar_url: null,
  is_direct: false,
  direct_targets: [],
  join_rule: 'invite',
  tags: [],
  state: 'joined',
  encrypted: null,
  is_space: false,
  is_tombstoned: false,
  is_voice: false,
  call_participants: [],
  room_type: null,
  supports_knock: true,
  supports_restricted: false,
  supports_knock_restricted: false,
  space_children: [],
  unread: 0,
  notifying: 0,
  highlight: 0,
  marked_unread: false,
  latest_event: null,
};

const permissions: RoomPermissionsView = {
  own_power_level: 50,
  can_post: true,
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
  document.body.replaceChildren();
  vi.clearAllMocks();
});

test('saves an access change with join-rule permission alone', async () => {
  core.roomHasSpaceParent.mockResolvedValue(false);
  core.roomAliases.mockResolvedValue([]);
  core.roomDirectoryVisibility.mockResolvedValue(false);
  core.setRoomJoinRule.mockResolvedValue(undefined);
  const instance = mount(RoomGeneralSettings, {
    target: document.body,
    props: { room, permissions, levels, onClose: () => {} },
  });
  await tick();

  const publicOption = Array.from(document.querySelectorAll<HTMLElement>('[role="radio"]')).find(
    (option) => option.textContent.includes('room.settingsJoinRulePublic')
  );
  if (!publicOption) throw new Error('Public access option missing');
  publicOption.click();
  await tick();

  const save = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find((button) =>
    button.textContent.includes('room.settingsSave')
  );
  if (!save) throw new Error('Save button missing');
  save.click();

  await vi.waitFor(() => {
    expect(core.setRoomJoinRule).toHaveBeenCalledWith('!room:example.org', 'public');
  });

  await unmount(instance);
});
