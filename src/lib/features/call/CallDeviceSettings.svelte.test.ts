// @vitest-environment happy-dom

import { render, screen, waitFor } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';

vi.mock('#lib/i18n.js', () => import('#lib/test-support/i18n.js'));
vi.mock('#lib/ui/media-query.svelte.js', () => ({
  createMediaQuery: () => ({ matches: true }),
}));

import CallDeviceSettings from './CallDeviceSettings.svelte';

afterEach(() => {
  vi.unstubAllGlobals();
});

test.each([
  { name: 'empty', initial: [] },
  { name: 'permission limited', initial: [{ deviceId: '', kind: 'audioinput', label: '' }] },
])('requests access and refreshes an $name device list', async ({ initial }) => {
  const available = [
    { deviceId: 'microphone', kind: 'audioinput', label: 'USB microphone' },
    { deviceId: 'speakers', kind: 'audiooutput', label: 'USB speakers' },
    { deviceId: 'camera', kind: 'videoinput', label: 'USB camera' },
  ];
  let devices = initial;
  const stopAudio = vi.fn();
  const stopVideo = vi.fn();
  const enumerateDevices = vi.fn(() => Promise.resolve(devices));
  const getUserMedia = vi.fn(() => {
    devices = available;
    return Promise.resolve({ getTracks: () => [{ stop: stopAudio }, { stop: stopVideo }] });
  });
  const mediaDevices = Object.assign(new EventTarget(), { enumerateDevices, getUserMedia });
  vi.stubGlobal('navigator', { mediaDevices });
  const user = userEvent.setup();

  render(CallDeviceSettings);
  await waitFor(() => {
    expect(enumerateDevices).toHaveBeenCalledOnce();
  });
  expect(getUserMedia).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'settings.callDevicesAllow' }));

  await waitFor(() => {
    expect(enumerateDevices).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('button', { name: 'settings.callDevicesAllow' })).toBeNull();
  });
  expect(getUserMedia).toHaveBeenCalledWith({ audio: true, video: true });
  expect(stopAudio).toHaveBeenCalledOnce();
  expect(stopVideo).toHaveBeenCalledOnce();

  for (const [setting, label] of [
    ['callInputDevice', 'USB microphone'],
    ['callOutputDevice', 'USB speakers'],
    ['callCameraDevice', 'USB camera'],
  ]) {
    await user.click(screen.getByRole('button', { name: `settings.${setting}` }));
    expect(await screen.findByRole('option', { name: label })).toBeInTheDocument();
    await user.keyboard('{Escape}');
  }
});
