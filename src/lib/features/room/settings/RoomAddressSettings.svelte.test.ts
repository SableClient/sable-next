// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';

import type { RoomPowerLevelsView, RoomSummary } from '#src/generated/protocol';

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

import RoomAddressSettings from './RoomAddressSettings.svelte';

const core = Object.assign(baseCore, {
  roomAliases: vi.fn<() => Promise<string[]>>(() => Promise.resolve([])),
  createRoomAlias: vi.fn<() => Promise<void>>(() => Promise.resolve()),
});

const levels = {
  state_default: 50,
  events: {},
} as unknown as RoomPowerLevelsView;

afterEach(() => {
  vi.clearAllMocks();
  core.session = null;
});

test('a bare address is created on your own server, not the room id', async () => {
  const user = userEvent.setup();
  core.session = { user_id: '@me:home.example' };
  const room = { room_id: '!v12roomhashwithoutserver' } as RoomSummary;
  render(RoomAddressSettings, { room, levels, ownPowerLevel: 100 });

  await user.type(
    await screen.findByRole('textbox', { name: 'room.addressesAdd' }),
    'lounge{Enter}'
  );

  expect(core.createRoomAlias).toHaveBeenCalledWith(
    '!v12roomhashwithoutserver',
    '#lounge:home.example'
  );
});
