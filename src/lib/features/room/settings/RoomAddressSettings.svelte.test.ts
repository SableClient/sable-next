// @vitest-environment happy-dom

import { flushSync, mount, tick, unmount } from 'svelte';
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
  document.body.replaceChildren();
  vi.clearAllMocks();
  core.session = null;
});

test('a bare address is created on your own server, not the room id', async () => {
  core.session = { user_id: '@me:home.example' };
  const room = { room_id: '!v12roomhashwithoutserver' } as RoomSummary;
  const instance = mount(RoomAddressSettings, {
    target: document.body,
    props: { room, levels, ownPowerLevel: 100 },
  });
  await tick();

  const input = document.querySelector<HTMLInputElement>('input[aria-label="room.addressesAdd"]');
  if (!input) throw new Error('address input missing');
  input.value = 'lounge';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  flushSync();
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await tick();

  expect(core.createRoomAlias).toHaveBeenCalledWith(
    '!v12roomhashwithoutserver',
    '#lounge:home.example'
  );
  void unmount(instance);
});
