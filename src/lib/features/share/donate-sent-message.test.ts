import { afterEach, expect, test, vi } from 'vitest';
import { isTauri } from '@tauri-apps/api/core';
import { type as osType } from '@tauri-apps/plugin-os';

import type { CoreClient } from '#lib/core/client.svelte.js';
import { rawInvoke } from '#lib/platform/raw-invoke.js';
import type { RoomListItemView } from '#src/generated/protocol';

import { donateSentMessage } from './donate-sent-message';

vi.mock('@tauri-apps/api/core', () => ({ isTauri: vi.fn() }));
vi.mock('@tauri-apps/plugin-os', () => ({ type: vi.fn() }));
vi.mock('#lib/platform/raw-invoke.js', () => ({ rawInvoke: vi.fn() }));

afterEach(() => {
  vi.resetAllMocks();
});

const avatar = new Uint8Array([1, 2, 3]);
const core = {
  session: { user_id: '@me:example.org' },
  media: { fetchMedia: vi.fn(() => Promise.resolve(avatar)) },
} as unknown as CoreClient;
const room = {
  room_id: '!room:example.org',
  display_name: 'Garden',
  avatar_url: 'mxc://example.org/a',
} as RoomListItemView;

test('donates the sent conversation with its avatar on iOS', async () => {
  vi.mocked(isTauri).mockReturnValue(true);
  vi.mocked(osType).mockReturnValue('ios');
  vi.mocked(rawInvoke).mockResolvedValue(undefined);
  donateSentMessage(core, room);
  await vi.waitFor(() => {
    expect(rawInvoke).toHaveBeenCalledWith('donate_sent_message', avatar, {
      'user-id': '@me:example.org',
      'room-id': '!room:example.org',
      name: 'Garden',
    });
  });
});

test('donates nothing off iOS', () => {
  vi.mocked(isTauri).mockReturnValue(true);
  vi.mocked(osType).mockReturnValue('android');
  donateSentMessage(core, room);
  expect(rawInvoke).not.toHaveBeenCalled();
});
