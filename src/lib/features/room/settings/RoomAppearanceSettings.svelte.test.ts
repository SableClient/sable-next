// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';

import type { CoreClient } from '#lib/core/client.svelte.js';
import type { RoomListItemView } from '#src/generated/protocol';

vi.mock('$app/state', () => import('#lib/test-support/app-state.js'));
vi.mock('$app/navigation', () => import('#lib/test-support/app-navigation.js'));

import { isBridgedSpace, setBridgedSpace } from '#lib/rooms/bridged-spaces.svelte.js';
import { mediaPreviewSettings } from '#lib/settings/media-previews.svelte.js';
import RoomAppearanceSettings from './RoomAppearanceSettings.svelte';

afterEach(() => {
  mediaPreviewSettings.stop();
  setBridgedSpace('!space:example.org', false);
});

test('a room can hide its media for you without touching the account default', async () => {
  const setRoomMediaPreviews = vi.fn(() =>
    Promise.resolve({ media_previews: 'off' as const, invite_avatars: null })
  );
  const core = {
    rpc: {
      account: {
        mediaPreviewConfig: vi.fn(() =>
          Promise.resolve({ media_previews: null, invite_avatars: null })
        ),
        setMediaPreviewConfig: vi.fn(),
        setRoomMediaPreviews,
      },
    },
    subscribeEvents: vi.fn(() => () => {}),
  };
  mediaPreviewSettings.start(core as unknown as CoreClient);
  const user = userEvent.setup();
  render(RoomAppearanceSettings, {
    room: { room_id: '!room:example.org' } as RoomListItemView,
  });

  await user.click(await screen.findByRole('combobox', { name: 'Load media' }));
  await user.click(await screen.findByRole('option', { name: 'Never' }));

  expect(setRoomMediaPreviews).toHaveBeenCalledWith({
    room_id: '!room:example.org',
    media_previews: 'off',
  });
  expect(core.rpc.account.setMediaPreviewConfig).not.toHaveBeenCalled();
});

test('a space can be marked as bridged and unmarked again', async () => {
  const user = userEvent.setup();
  render(RoomAppearanceSettings, {
    room: { room_id: '!space:example.org' } as RoomListItemView,
  });

  const toggle = screen.getByRole('switch', { name: 'Bridged space' });
  expect(toggle).not.toBeChecked();
  await user.click(toggle);

  expect(isBridgedSpace('!space:example.org')).toBe(true);
  expect(toggle).toBeChecked();
  await user.click(toggle);
  expect(isBridgedSpace('!space:example.org')).toBe(false);
});
