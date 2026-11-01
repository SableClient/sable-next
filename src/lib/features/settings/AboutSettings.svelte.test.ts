// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { expect, test, vi } from 'vitest';

import type { HomeserverSoftwareView } from '#src/generated/protocol';

vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('#lib/core/context.js');
const desktopDataDir = vi.hoisted(() => vi.fn(() => Promise.resolve<string | null>(null)));
vi.mock('#lib/platform/data-dir.js', () => ({ desktopDataDir }));

import { core } from '#lib/core/__mocks__/context.js';

import AboutSettings from './AboutSettings.svelte';

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
