// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';

const platform = vi.hoisted(() => ({
  listScreenAudioApps: vi.fn<() => Promise<string[]>>(),
  lastScreenAudioChoice: vi.fn(() => ({ kind: 'none' as const })),
  screenAudioPicksMany: vi.fn(() => true),
}));
vi.mock('#lib/platform/screen-audio.js', () => platform);

import ScreenShareAudioDialog from './ScreenShareAudioDialog.svelte';

afterEach(() => {
  platform.listScreenAudioApps.mockReset();
  platform.screenAudioPicksMany.mockReturnValue(true);
});

function open() {
  const onShare = vi.fn();
  const onCancel = vi.fn();
  render(ScreenShareAudioDialog, { onShare, onCancel });
  return { onShare, onCancel, user: userEvent.setup() };
}

test('shares no audio unless another source is picked', async () => {
  const { onShare, user } = open();

  await user.click(await screen.findByRole('button', { name: 'Share' }));

  expect(onShare).toHaveBeenCalledWith({ kind: 'none' });
  expect(platform.listScreenAudioApps).not.toHaveBeenCalled();
});

test('shares every app except the ones left out', async () => {
  platform.listScreenAudioApps.mockResolvedValue(['Firefox', 'Spotify']);
  const { onShare, user } = open();

  await user.click(await screen.findByRole('radio', { name: /Every app/ }));
  await user.click(await screen.findByRole('checkbox', { name: 'Spotify' }));
  await user.click(screen.getByRole('button', { name: 'Share' }));

  expect(onShare).toHaveBeenCalledWith({ kind: 'system', exclude: ['Spotify'] });
});

test('needs at least one chosen app before sharing', async () => {
  platform.listScreenAudioApps.mockResolvedValue(['mpv']);
  const { onShare, user } = open();

  await user.click(await screen.findByRole('radio', { name: /Chosen apps/ }));
  expect(await screen.findByRole('button', { name: 'Share' })).toBeDisabled();

  await user.click(await screen.findByRole('checkbox', { name: 'mpv' }));
  await user.click(screen.getByRole('button', { name: 'Share' }));

  expect(onShare).toHaveBeenCalledWith({ kind: 'apps', include: ['mpv'] });
});

test('says so when nothing is playing, and lists apps after a refresh', async () => {
  platform.listScreenAudioApps.mockResolvedValueOnce([]).mockResolvedValueOnce(['mpv']);
  const { user } = open();

  await user.click(await screen.findByRole('radio', { name: /Every app/ }));
  expect(await screen.findByText(/No app is playing sound/)).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: 'Refresh the list of apps' }));

  expect(await screen.findByRole('checkbox', { name: 'mpv' })).toBeInTheDocument();
  expect(platform.listScreenAudioApps).toHaveBeenCalledTimes(2);
});

test('cancelling shares nothing', async () => {
  const { onShare, onCancel, user } = open();

  await user.click(await screen.findByRole('button', { name: 'Cancel' }));

  expect(onCancel).toHaveBeenCalled();
  expect(onShare).not.toHaveBeenCalled();
});

test('keeps the remembered apps on screen when the list cannot be read', async () => {
  platform.lastScreenAudioChoice.mockReturnValueOnce({ kind: 'apps', include: ['mpv'] } as never);
  platform.listScreenAudioApps.mockRejectedValue(new Error('no pipewire'));
  open();

  expect((await screen.findByRole('alert')).textContent).toMatch(/Refresh to try again/);
  expect(screen.getByRole('checkbox', { name: /mpv/ })).toBeChecked();
});

test('on a platform that shares one app, every app needs no list and a pick replaces the last', async () => {
  platform.screenAudioPicksMany.mockReturnValue(false);
  platform.listScreenAudioApps.mockResolvedValue(['chrome', 'Spotify']);
  const { onShare, user } = open();

  await user.click(await screen.findByRole('radio', { name: /Every app/ }));
  expect(platform.listScreenAudioApps).not.toHaveBeenCalled();
  await user.click(screen.getByRole('radio', { name: /One app/ }));
  await user.click(await screen.findByRole('radio', { name: 'chrome' }));
  await user.click(screen.getByRole('radio', { name: 'Spotify' }));
  await user.click(screen.getByRole('button', { name: 'Share' }));

  expect(onShare).toHaveBeenCalledWith({ kind: 'apps', include: ['Spotify'] });
});
