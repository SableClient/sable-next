import { afterEach, expect, test, vi } from 'vitest';

import type { CoreClient } from '#lib/core/client.svelte.js';
import { preferences } from './preferences.svelte.js';

import type { MediaPreviewConfigView } from '#src/generated/protocol';

import { mediaPreviewSettings, previewsShown } from './media-previews.svelte';

function fakeCore(stored: MediaPreviewConfigView) {
  const setMediaPreviewConfig = vi.fn((config: MediaPreviewConfigView) => Promise.resolve(config));
  const core = {
    commands: {
      mediaPreviewConfig: vi.fn(() => Promise.resolve(stored)),
      setMediaPreviewConfig,
    },
    subscribeEvents: vi.fn(() => () => {}),
  };
  return { core: core as unknown as CoreClient, setMediaPreviewConfig };
}

afterEach(() => {
  mediaPreviewSettings.stop();
  preferences.mediaAutoLoad = 'on';
});

test.each([
  ['on', 'public', true],
  ['private', 'invite', true],
  ['private', 'knock_restricted', true],
  ['private', 'public', false],
  ['private', null, false],
  ['off', 'invite', false],
] as const)('%s previews in a %s room show: %s', (level, joinRule, shown) => {
  expect(previewsShown(level, joinRule)).toBe(shown);
});

test('adopts the stored config and mirrors it into the preference', async () => {
  const { core } = fakeCore({ media_previews: 'private', invite_avatars: null });
  mediaPreviewSettings.start(core);

  await vi.waitFor(() => {
    expect(mediaPreviewSettings.mediaPreviews).toBe('private');
  });
  expect(mediaPreviewSettings.inviteAvatars).toBe('on');
  expect(preferences.mediaAutoLoad).toBe('private');
});

test('a change sends only the fields it sets and keeps the rest locally', async () => {
  const { core, setMediaPreviewConfig } = fakeCore({ media_previews: null, invite_avatars: null });
  mediaPreviewSettings.start(core);

  await mediaPreviewSettings.set({ invite_avatars: 'off' });

  expect(setMediaPreviewConfig).toHaveBeenCalledWith({
    media_previews: null,
    invite_avatars: 'off',
  });
  expect(mediaPreviewSettings.inviteAvatars).toBe('off');
  preferences.mediaAutoLoad = 'off';
  expect(mediaPreviewSettings.mediaPreviews).toBe('off');
  await mediaPreviewSettings.set({ media_previews: 'on' });
  expect(preferences.mediaAutoLoad).toBe('on');
  expect(setMediaPreviewConfig).toHaveBeenLastCalledWith({
    media_previews: 'on',
    invite_avatars: null,
  });
  expect(mediaPreviewSettings.inviteAvatars).toBe('off');
});
