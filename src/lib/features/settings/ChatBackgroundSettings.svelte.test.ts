// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';

vi.mock('#lib/core/context.js');
vi.mock('#lib/i18n.js', () => import('#lib/test-support/i18n.js'));

import { core as baseCore } from '#lib/core/__mocks__/context.js';
import { preferences, setPreference } from '#lib/settings/preferences.svelte.js';

import ChatBackgroundSettings from './ChatBackgroundSettings.svelte';

const uploadMedia = vi.fn<(mime: string, bytes: Uint8Array) => Promise<string>>();
Object.assign(baseCore, { uploadMedia });

afterEach(() => {
  setPreference('chatBackgroundImage', '');
});

test('uploads the chosen picture and can remove it again', async () => {
  uploadMedia.mockResolvedValue('mxc://example.org/wall');
  const user = userEvent.setup();
  render(ChatBackgroundSettings);

  await user.upload(
    screen.getByLabelText('settings.chatBackgroundChoose'),
    new File(['picture'], 'wall.png', { type: 'image/png' })
  );

  await vi.waitFor(() => {
    expect(preferences.chatBackgroundImage).toBe('mxc://example.org/wall');
  });
  expect(uploadMedia).toHaveBeenCalledWith('image/png', expect.any(Uint8Array));

  await user.click(await screen.findByRole('button', { name: 'settings.chatBackgroundRemove' }));
  expect(preferences.chatBackgroundImage).toBe('');
});
