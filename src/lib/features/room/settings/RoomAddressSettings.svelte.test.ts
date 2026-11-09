// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';

import type { RoomPowerLevelsView, RoomListItemView } from '#src/generated/protocol';

vi.mock('#lib/core/context.js');
vi.mock('#lib/i18n.js', () => import('#lib/test-support/i18n.js'));

import { core as baseCore } from '#lib/core/__mocks__/context.js';

import RoomAddressSettings from './RoomAddressSettings.svelte';

const core = baseCore;
Object.assign(core.rpc.rooms, {
  aliases: vi.fn<() => Promise<string[]>>(() => Promise.resolve([])),
  createAlias: vi.fn<() => Promise<null>>(() => Promise.resolve(null)),
});

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

afterEach(() => {
  vi.clearAllMocks();
  core.session = null;
});

test('a bare address is created on your own server, not the room id', async () => {
  const user = userEvent.setup();
  core.session = { user_id: '@me:home.example' };
  const room = { room_id: '!v12roomhashwithoutserver' } as RoomListItemView;
  render(RoomAddressSettings, { room, levels, ownPowerLevel: 100 });

  await user.type(await screen.findByRole('textbox', { name: 'common.add' }), 'lounge{Enter}');

  expect(core.rpc.rooms.createAlias).toHaveBeenCalledWith({
    room_id: '!v12roomhashwithoutserver',
    alias: '#lounge:home.example',
  });
});

test('an address on another server is refused before reaching the server', async () => {
  const user = userEvent.setup();
  core.session = { user_id: '@me:home.example' };
  const room = { room_id: '!room' } as RoomListItemView;
  render(RoomAddressSettings, { room, levels, ownPowerLevel: 100 });

  await user.type(
    await screen.findByRole('textbox', { name: 'common.add' }),
    '#lounge:elsewhere.example{Enter}'
  );

  expect(core.rpc.rooms.createAlias).not.toHaveBeenCalled();
  expect(screen.getByRole('alert')).toHaveTextContent('room.addressesForeignServer');
});
