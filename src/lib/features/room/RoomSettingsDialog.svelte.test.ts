// @vitest-environment happy-dom

import { mount, tick, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

import type { RoomPermissionsView } from '#src/generated/RoomPermissionsView';
import type { RoomSummary } from '#src/generated/RoomSummary';

const coreStub = vi.hoisted(() => {
  const stub = {
    roomPermissions: vi.fn(),
    roomPowerLevels: vi.fn(),
    roomStateEvent: vi.fn(),
    roomAliases: vi.fn(),
    roomDirectoryVisibility: vi.fn(),
  };

  return Object.assign(stub, { commands: stub });
});

vi.mock('#lib/core/context.js', () => ({ useCoreClient: () => coreStub }));
vi.mock('#lib/i18n.js', () => ({
  i18n: {
    subscribe(run: (value: { t: (key: string) => string }) => void) {
      run({ t: (key) => key });
      return () => {};
    },
  },
}));

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
  has_space_parent: false,
  supports_knock: true,
  supports_restricted: true,
  supports_knock_restricted: true,
  space_children: [],
  unread: 0,
  highlight: 0,
  marked_unread: false,
  latest_event: null,
};

function permissions(canChangeJoinRule: boolean): RoomPermissionsView {
  return {
    own_power_level: canChangeJoinRule ? 100 : 0,
    can_post: true,
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

async function render(
  canChangeJoinRule: boolean,
  hasSpaceParent = false
): Promise<ReturnType<typeof mount>> {
  coreStub.roomPermissions.mockResolvedValue(permissions(canChangeJoinRule));
  coreStub.roomPowerLevels.mockResolvedValue({
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
  coreStub.roomStateEvent.mockResolvedValue(null);
  coreStub.roomAliases.mockResolvedValue([]);
  coreStub.roomDirectoryVisibility.mockResolvedValue(false);
  const instance = mount(RoomSettingsDialog, {
    target: document.body,
    props: {
      open: true,
      room: { ...room, has_space_parent: hasSpaceParent },
      onOpenChange: () => {},
    },
  });
  await tick();
  await tick();
  return instance;
}

afterEach(() => {
  document.body.replaceChildren();
  vi.clearAllMocks();
});

test('does not offer to replace an unsupported join rule without permission', async () => {
  const instance = await render(false);

  expect(document.body.textContent).not.toContain('room.settingsJoinRuleUnsettable');

  await unmount(instance);
});

test('warns authorized users before replacing an unsupported join rule', async () => {
  const instance = await render(true);

  expect(document.body.textContent).toContain('room.settingsJoinRuleUnsettable');

  await unmount(instance);
});

test('offers space-based rules to a room in a space', async () => {
  const instance = await render(true, true);

  expect(document.body.textContent).toContain('room.settingsJoinRuleRestricted');
  expect(document.body.textContent).toContain('room.settingsJoinRuleKnockRestricted');
  expect(document.body.textContent).not.toContain('room.settingsJoinRuleUnsettable');

  await unmount(instance);
});
