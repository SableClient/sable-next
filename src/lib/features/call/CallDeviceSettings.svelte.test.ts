// @vitest-environment happy-dom

import { render, screen, waitFor } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';

vi.mock('#lib/i18n.js', () => import('#lib/test-support/i18n.js'));

import CallDeviceSettings from './CallDeviceSettings.svelte';
import * as inputMeter from './input-meter';

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

test.each(['closing settings', 'stopping the test'])(
  'releases a pending microphone test after %s',
  async (ending) => {
    const mediaDevices = Object.assign(new EventTarget(), {
      enumerateDevices: vi.fn(() => Promise.resolve([])),
    });
    vi.stubGlobal('navigator', { mediaDevices });
    const meter = Promise.withResolvers<(() => void) | null>();
    const start = vi.spyOn(inputMeter, 'startInputMeter').mockReturnValueOnce(meter.promise);
    const stop = vi.fn();
    const user = userEvent.setup();
    const instance = render(CallDeviceSettings);

    await user.click(screen.getByRole('button', { name: 'settings.callMicTest' }));
    await waitFor(() => {
      expect(start).toHaveBeenCalledOnce();
    });
    if (ending === 'closing settings') instance.unmount();
    else await user.click(screen.getByRole('button', { name: 'common.stopTest' }));
    meter.resolve(stop);
    await waitFor(() => {
      expect(stop).toHaveBeenCalledOnce();
    });
    if (ending !== 'closing settings') {
      expect(screen.getByRole('button', { name: 'settings.callMicTest' })).toBeInTheDocument();
      instance.unmount();
    }
    expect(start).toHaveBeenCalledOnce();
  }
);

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
    await user.click(screen.getByRole('combobox', { name: `settings.${setting}` }));
    expect(await screen.findByRole('option', { name: label })).toBeInTheDocument();
    await user.keyboard('{Escape}');
  }
});

test('shows why microphone access failed', async () => {
  const enumerateDevices = vi.fn(() =>
    Promise.resolve([{ deviceId: '', kind: 'audioinput', label: '' }])
  );
  const getUserMedia = vi.fn(() =>
    Promise.reject(new DOMException('Could not start audio source', 'NotReadableError'))
  );
  const mediaDevices = Object.assign(new EventTarget(), { enumerateDevices, getUserMedia });
  vi.stubGlobal('navigator', { mediaDevices });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  const user = userEvent.setup();

  render(CallDeviceSettings);
  await user.click(await screen.findByRole('button', { name: 'settings.callDevicesAllow' }));

  expect(
    await screen.findByText(
      'settings.callDevicesFailed:NotReadableError: Could not start audio source'
    )
  ).toBeInTheDocument();
  expect(getUserMedia).toHaveBeenCalledWith({ audio: true });
});

test('plays the microphone test through the output device and restarts it on new settings', async () => {
  const enumerateDevices = vi.fn(() =>
    Promise.resolve([
      { deviceId: 'mixer-a', kind: 'audioinput', label: 'Mixer A' },
      { deviceId: 'mixer-b', kind: 'audioinput', label: 'Mixer B' },
      { deviceId: 'speakers', kind: 'audiooutput', label: 'USB speakers' },
    ])
  );
  vi.stubGlobal('navigator', {
    mediaDevices: Object.assign(new EventTarget(), { enumerateDevices }),
  });
  const { preferences } = await import('#lib/settings/preferences.svelte.js');
  preferences.audioInputDevice = 'mixer-a';
  preferences.audioOutputDevice = 'speakers';
  const stop = vi.fn();
  const start = vi.spyOn(inputMeter, 'startInputMeter').mockResolvedValue(stop);
  const user = userEvent.setup();
  const instance = render(CallDeviceSettings);

  await user.click(screen.getByRole('button', { name: 'settings.callMicTest' }));
  await waitFor(() => {
    expect(start).toHaveBeenCalledWith(
      'mixer-a',
      expect.any(Function),
      expect.objectContaining({ outputDevice: 'speakers' })
    );
  });

  await user.click(screen.getByRole('combobox', { name: 'settings.callInputDevice' }));
  await user.click(await screen.findByRole('option', { name: 'Mixer B' }));
  await waitFor(() => {
    expect(start).toHaveBeenLastCalledWith(
      'mixer-b',
      expect.any(Function),
      expect.objectContaining({ outputDevice: 'speakers' })
    );
  });
  expect(stop).toHaveBeenCalledOnce();

  const echoCancellation = preferences.echoCancellation;
  preferences.echoCancellation = !echoCancellation;
  await waitFor(() => {
    expect(start.mock.lastCall?.[2]?.constraints.echoCancellation).toBe(!echoCancellation);
  });
  expect(stop).toHaveBeenCalledTimes(2);

  instance.unmount();
  expect(stop).toHaveBeenCalledTimes(3);
  preferences.echoCancellation = echoCancellation;
  preferences.audioInputDevice = '';
  preferences.audioOutputDevice = '';
});
