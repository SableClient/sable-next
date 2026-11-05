// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { afterEach, expect, test, vi } from 'vitest';
import { isTauri } from '@tauri-apps/api/core';

import type { HomeserverSoftwareView } from '#src/generated/protocol';
import { supporter } from '#lib/supporter/supporter.svelte.js';

vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('#lib/core/context.js');
vi.mock('@tauri-apps/api/core', () => ({ isTauri: vi.fn(() => false) }));
vi.mock('@tauri-apps/plugin-os', () => ({ type: () => 'ios' }));
const desktopDataDir = vi.hoisted(() => vi.fn(() => Promise.resolve<string | null>(null)));
vi.mock('#lib/platform/data-dir.js', () => ({ desktopDataDir }));

import { core } from '#lib/core/__mocks__/context.js';

import AboutSettings from './AboutSettings.svelte';

afterEach(() => {
  vi.mocked(isTauri).mockReturnValue(false);
  vi.unstubAllGlobals();
  supporter.stop();
});

test('adds the homeserver once it is known, or leaves it out when it cannot be read', async () => {
  let resolve: (info: {
    homeserver: string;
    server: HomeserverSoftwareView | null;
  }) => void = () => {};
  core.rpc.session.homeserverInfo.mockReturnValueOnce(
    new Promise((done) => {
      resolve = done;
    })
  );
  const first = render(AboutSettings);

  expect(await screen.findByRole('heading', { name: 'Options' })).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'Homeserver' })).not.toBeInTheDocument();

  resolve({
    homeserver: 'https://matrix.example.org/',
    server: { name: 'Synapse', version: '1.2' },
  });
  expect(await screen.findByRole('heading', { name: 'Homeserver' })).toBeInTheDocument();
  expect(screen.getByText('https://matrix.example.org')).toBeInTheDocument();
  expect(screen.getByText('Synapse')).toBeInTheDocument();
  first.unmount();

  const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
  const failure = new Error('offline');
  core.rpc.session.homeserverInfo.mockRejectedValueOnce(failure);
  render(AboutSettings);

  await vi.waitFor(() => {
    expect(debug).toHaveBeenCalledWith('[sable settings] homeserver info unavailable', failure);
  });
  expect(screen.getByRole('heading', { name: 'Options' })).toBeInTheDocument();
  expect(screen.queryByRole('heading', { name: 'Homeserver' })).not.toBeInTheDocument();
  debug.mockRestore();
});

test('desktop builds show the folder Sable keeps its data in', async () => {
  desktopDataDir.mockResolvedValueOnce('/home/me/.local/share/moe.sable.next');
  render(AboutSettings);

  expect(await screen.findByText('/home/me/.local/share/moe.sable.next')).toBeInTheDocument();
  expect(screen.getByText('Data folder')).toBeInTheDocument();
});

test('package-managed desktop builds expose automatic update checks', () => {
  vi.stubGlobal('sableElectron', { platform: 'linux' });
  vi.stubGlobal('__SABLE_AUTO_UPDATE__', false);
  render(AboutSettings);

  expect(
    screen.getByRole('switch', { name: 'Check for updates automatically' })
  ).toBeInTheDocument();
});

test.each(['web', 'ios'])('donation controls on %s', (platform) => {
  const native = platform === 'ios';
  vi.mocked(isTauri).mockReturnValue(native);
  supporter.config = { serviceUrl: 'https://awards.example', keys: {} };
  render(AboutSettings);

  expect(screen.getByRole('link', { name: 'Source code' })).toBeInTheDocument();
  if (native) {
    expect(screen.queryByRole('link', { name: 'Support Sable' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Support Sable' })).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Verify with Open Collective' })
    ).not.toBeInTheDocument();
  } else {
    expect(screen.getByRole('link', { name: 'Support Sable' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Support Sable' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Verify with Open Collective' })).toBeInTheDocument();
  }
});
