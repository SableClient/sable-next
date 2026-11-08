// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';

vi.mock('#lib/features/notifications/sound.js', () => ({
  playSound: vi.fn(() => Promise.resolve()),
}));

import SoundVolumeSettings from './SoundVolumeSettings.svelte';

test('saves the volume set with the slider', async () => {
  const user = userEvent.setup();
  render(SoundVolumeSettings);

  screen.getAllByRole('slider')[0].focus();
  await user.keyboard('{ArrowLeft}');

  expect(JSON.parse(localStorage.getItem('sable-preferences') ?? '{}')).toMatchObject({
    soundsNotificationVolume: 0.95,
  });
});
