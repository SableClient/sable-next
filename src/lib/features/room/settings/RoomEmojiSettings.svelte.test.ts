// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { afterEach, expect, test, vi } from 'vitest';

import type { ImagePackView, RoomSummary } from '#src/generated/protocol';

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
