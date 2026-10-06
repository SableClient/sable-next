// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';

import type {
  ImagePackView,
  RoomPermissionsView,
  RoomPowerLevelsView,
  RoomSummary,
} from '#src/generated/protocol';

vi.mock('#lib/core/context.js');
vi.mock('#lib/i18n.js', () => import('#lib/test-support/i18n.js'));

import { core as baseCore } from '#lib/core/__mocks__/context.js';

import RoomEmojiSettings from './RoomEmojiSettings.svelte';

const core = Object.assign(baseCore, {
  imagePacks: vi.fn<() => Promise<ImagePackView[]>>(() => Promise.resolve([])),
});

function pack(overrides: Partial<ImagePackView>): ImagePackView {
  return {
    id: 'stickers',
    origin: 'room',
    room_id: '!space:home.example',
    name: 'Stickers',
    avatar_url: null,
    declared_name: 'Stickers',
    declared_avatar_url: null,
    stable_event: true,
    legacy_event: false,
    attribution: null,
    usage: [],
    images: [],
    ...overrides,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

test('a pack enabled for every room is still listed in its own room', async () => {
  core.imagePacks.mockResolvedValue([
    pack({ origin: 'global' }),
    pack({ id: 'parent', name: 'Parent pack', origin: 'space', room_id: '!parent:home.example' }),
  ]);
  const room = { room_id: '!space:home.example' } as RoomSummary;
  render(RoomEmojiSettings, { room, permissions: null, levels: null });

  expect(await screen.findByText('Stickers')).toBeTruthy();
  expect(screen.queryByText('Parent pack')).toBeNull();
  expect(screen.queryByText('room.emojisEmpty')).toBeNull();
});

test('a legacy-only pack is copied verbatim to the stable event type', async () => {
  const legacy = { pack: { display_name: 'Neo', 'x.custom': 1 }, images: {} };
  core.imagePacks.mockResolvedValue([pack({ stable_event: false, legacy_event: true })]);
  core.roomStateEvent.mockResolvedValue(legacy);
  const sendStateEvent = vi.fn<() => Promise<void>>(() => Promise.resolve());
  Object.assign(core, { sendStateEvent });
  const room = { room_id: '!space:home.example' } as RoomSummary;
  const levels = { events: {}, state_default: 50 } as unknown as RoomPowerLevelsView;
  const permissions = { own_power_level: 100 } as RoomPermissionsView;
  render(RoomEmojiSettings, { room, permissions, levels });

  await userEvent.click(await screen.findByRole('button', { name: 'room.emojisLegacyConvert:1' }));

  await vi.waitFor(() => {
    expect(sendStateEvent).toHaveBeenCalledWith(
      '!space:home.example',
      'm.room.image_pack',
      'stickers',
      legacy
    );
  });
  expect(core.roomStateEvent).toHaveBeenCalledWith(
    '!space:home.example',
    'im.ponies.room_emotes',
    'stickers'
  );
});
