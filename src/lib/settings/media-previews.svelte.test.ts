import { afterEach, expect, test, vi } from 'vitest';

import type { CoreClient } from '#lib/core/client.svelte.js';
import { preferences } from './preferences.svelte.js';

import {
  MEDIA_PREVIEW_EVENT,
  UNSTABLE_MEDIA_PREVIEW_EVENT,
  mediaPreviewSettings,
  parseMediaPreviewConfig,
  previewsShown,
} from './media-previews.svelte';

function fakeCore(accountData: Record<string, unknown>) {
  const setAccountData = vi.fn(() => Promise.resolve());
  const core = {
    commands: {
      accountData: vi.fn((type: string) => Promise.resolve(accountData[type] ?? null)),
      roomAccountData: vi.fn(() => Promise.resolve(null)),
      setAccountData,
    },
    subscribeEvents: vi.fn(() => () => {}),
  };
  return { core: core as unknown as CoreClient, setAccountData };
}

afterEach(() => {
  mediaPreviewSettings.stop();
  preferences.mediaAutoLoad = 'on';
});

test('an unknown value is treated as off, a missing one inherits', () => {
  expect(parseMediaPreviewConfig({ media_previews: 'sometimes', invite_avatars: 'maybe' })).toEqual(
    {
      media_previews: 'off',
      invite_avatars: 'off',
    }
  );
  expect(parseMediaPreviewConfig({})).toEqual({});
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

test('reads the stable type first, then the unstable one', async () => {
  const { core } = fakeCore({ [UNSTABLE_MEDIA_PREVIEW_EVENT]: { media_previews: 'private' } });
  mediaPreviewSettings.start(core);

  await vi.waitFor(() => {
    expect(mediaPreviewSettings.mediaPreviews).toBe('private');
  });
  expect(mediaPreviewSettings.inviteAvatars).toBe('on');
  expect(preferences.mediaAutoLoad).toBe('private');
});

test('writes both types so other clients see the change', async () => {
  const { core, setAccountData } = fakeCore({});
  mediaPreviewSettings.start(core);

  await mediaPreviewSettings.set({ invite_avatars: 'off' });

  expect(setAccountData).toHaveBeenCalledWith(MEDIA_PREVIEW_EVENT, { invite_avatars: 'off' });
  expect(setAccountData).toHaveBeenCalledWith(UNSTABLE_MEDIA_PREVIEW_EVENT, {
    invite_avatars: 'off',
  });
  expect(mediaPreviewSettings.inviteAvatars).toBe('off');
  preferences.mediaAutoLoad = 'off';
  expect(mediaPreviewSettings.mediaPreviews).toBe('off');
  await mediaPreviewSettings.set({ media_previews: 'on' });
  expect(preferences.mediaAutoLoad).toBe('on');
  expect(setAccountData).toHaveBeenCalledWith(MEDIA_PREVIEW_EVENT, {
    invite_avatars: 'off',
    media_previews: 'on',
  });
  expect(setAccountData).toHaveBeenCalledWith(UNSTABLE_MEDIA_PREVIEW_EVENT, {
    invite_avatars: 'off',
    media_previews: 'on',
  });
});
