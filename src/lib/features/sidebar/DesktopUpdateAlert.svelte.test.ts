// @vitest-environment happy-dom

import { fireEvent, render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { preferences } from '#lib/settings/preferences.svelte.js';
import Harness from './DesktopUpdateAlertHarness.test.svelte';

const latestVersion = vi.fn<() => Promise<string | null>>();

beforeEach(() => {
  preferences.autoUpdateCheck = true;
  vi.stubEnv('VITE_APP_VERSION', '1.2.3');
  vi.stubGlobal('__SABLE_AUTO_UPDATE__', false);
  vi.stubGlobal('sableElectron', { platform: 'linux', latestVersion });
  latestVersion.mockResolvedValue('1.3.0');
});

afterEach(() => {
  preferences.autoUpdateCheck = true;
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

test('package-managed builds announce updates without offering to install them', async () => {
  render(Harness);

  expect(
    await screen.findByText(
      'A newer version is available. Update Sable through your package manager.'
    )
  ).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Install' })).not.toBeInTheDocument();
});

test('dismissing an update lasts until a newer package version is available', async () => {
  const interval = vi.spyOn(globalThis, 'setInterval');
  render(Harness);
  await fireEvent.click(await screen.findByRole('button', { name: 'Later' }));
  expect(screen.queryByRole('button', { name: 'Later' })).not.toBeInTheDocument();

  const poll = interval.mock.calls.find(([, delay]) => delay === 300_000)?.[0];
  if (typeof poll !== 'function') throw new Error('Update polling was not started');
  poll();
  await tick();
  expect(screen.queryByRole('button', { name: 'Later' })).not.toBeInTheDocument();

  latestVersion.mockResolvedValue('1.4.0');
  poll();
  expect(await screen.findByRole('button', { name: 'Later' })).toBeInTheDocument();
});

test('automatic package checks respect the preference', async () => {
  preferences.autoUpdateCheck = false;
  latestVersion.mockClear();
  render(Harness);
  await tick();

  expect(latestVersion).not.toHaveBeenCalled();
});
