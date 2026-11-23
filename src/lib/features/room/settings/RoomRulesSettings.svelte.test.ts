// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { tick } from 'svelte';
import { expect, test, vi } from 'vitest';

import type {
  RoomPermissionsView,
  RoomPowerLevelsView,
  RoomListItemView,
  RoomRulesSettingsView,
} from '#src/generated/protocol';

vi.mock('#lib/core/context.js');
vi.mock('#lib/rooms/room-list.svelte.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('#lib/rooms/room-list.svelte.js')>()),
  useRoomList: () => ({ byId: () => undefined, roomSpaces: () => undefined }),
}));
vi.mock('#lib/i18n.js', () => import('#lib/test-support/i18n.js'));

import { core } from '#lib/core/__mocks__/context.js';
import { leaveUnlessUnsaved } from '#lib/ui/unsaved-guard.js';

import RoomRulesSettingsHarness from './RoomRulesSettingsHarness.test.svelte';

Object.assign(core.rpc.room_state, {
  ownRules: vi.fn<() => Promise<RoomRulesSettingsView | null>>(),
  rules: vi.fn<() => Promise<unknown>>(),
});

const room = { room_id: '!room:example.org', name: 'Example room' } as RoomListItemView;
const permissions = { own_power_level: 100 } as RoomPermissionsView;
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

const RULES = { html: '<p>Be kind</p>', require_acceptance: false, delegate_to: null };
const settings = { room, permissions, levels };

async function settle(): Promise<void> {
  for (let round = 0; round < 10; round++) await tick();
}

function loadOnDemand(): () => void {
  const pending: ((rules: RoomRulesSettingsView) => void)[] = [];
  core.rpc.room_state.ownRules.mockImplementation(
    () =>
      new Promise((resolve) => {
        pending.push(resolve);
      })
  );
  return () => {
    for (const resolve of pending.splice(0)) resolve(RULES);
  };
}

// Reopening the section mounts the page before its rules load again.
test('leaving the rules while they reload goes ahead', async () => {
  const load = loadOnDemand();
  const view = render(RoomRulesSettingsHarness, { settings, shown: true });
  load();
  await settle();
  await view.rerender({ settings, shown: false });
  await settle();
  await view.rerender({ settings, shown: true });
  await settle();

  const proceed = vi.fn<() => void>();
  leaveUnlessUnsaved(proceed);
  expect(proceed).toHaveBeenCalledOnce();
});

test('an unsaved edit holds leaving once the rules load', async () => {
  const load = loadOnDemand();
  const user = userEvent.setup();
  render(RoomRulesSettingsHarness, { settings, shown: true });
  load();
  await user.click(await screen.findByRole('switch', { name: 'room.rulesRequire' }));

  const proceed = vi.fn<() => void>();
  leaveUnlessUnsaved(proceed);
  expect(proceed).not.toHaveBeenCalled();
});
