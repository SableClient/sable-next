import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  app: { isPackaged: true, getVersion: (): string => '2.0.0' },
  existsSync: vi.fn(() => true),
  setFeedURL: vi.fn(),
  handle: vi.fn<(channel: string, handler: (event: { senderFrame: object }) => unknown) => void>(),
  checkForUpdates: vi.fn(),
}));

vi.mock('electron', () => ({ app: mocks.app, ipcMain: { handle: mocks.handle } }));
vi.mock('electron-updater', () => ({ autoUpdater: mocks }));
vi.mock('node:fs', () => ({ existsSync: mocks.existsSync }));

import { registerUpdater, setUpdateChannel, supportsAutoUpdate } from './updater';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.stubGlobal('process', {
    ...process,
    platform: 'linux',
    resourcesPath: '/opt/Sable/resources',
  });
  vi.stubEnv('FLATPAK_ID', '');
  vi.stubEnv('APPIMAGE', '');
  mocks.app.isPackaged = true;
  mocks.app.getVersion = () => '2.0.0';
  mocks.existsSync.mockReturnValue(true);
});

test('AUR packages without updater metadata do not configure or check the Debian feed', async () => {
  mocks.existsSync.mockReturnValue(false);
  expect(supportsAutoUpdate()).toBe(false);
  setUpdateChannel('stable');
  expect(mocks.setFeedURL).not.toHaveBeenCalled();
  registerUpdater(() => true);
  const handler = mocks.handle.mock.calls.find(([channel]) => channel === 'sable-update-check');
  expect(handler).toBeDefined();
  expect(await handler?.[1]({ senderFrame: {} })).toBeNull();
  expect(mocks.checkForUpdates).not.toHaveBeenCalled();
});

test('native deb and rpm packages retain their updater', () => {
  expect(supportsAutoUpdate()).toBe(true);
  expect(mocks.existsSync).toHaveBeenCalledWith('/opt/Sable/resources/app-update.yml');
});

test('AppImages retain updates without adjacent metadata', () => {
  mocks.existsSync.mockReturnValue(false);
  vi.stubEnv('APPIMAGE', '/home/user/Sable.AppImage');
  expect(supportsAutoUpdate()).toBe(true);
});

test('Flatpak and development builds do not offer self updates', () => {
  vi.stubEnv('FLATPAK_ID', 'moe.sable.client');
  expect(supportsAutoUpdate()).toBe(false);
  vi.stubEnv('FLATPAK_ID', '');
  mocks.app.isPackaged = false;
  expect(supportsAutoUpdate()).toBe(false);
});

test.each(['darwin', 'win32'])('%s retains updates without Linux metadata', (platform) => {
  vi.stubGlobal('process', { ...process, platform });
  mocks.existsSync.mockReturnValue(false);
  expect(supportsAutoUpdate()).toBe(true);
});

test('MAS builds do not configure or check for updates', async () => {
  vi.stubGlobal('process', { ...process, platform: 'darwin', mas: true });
  expect(supportsAutoUpdate()).toBe(false);
  setUpdateChannel('stable');
  expect(mocks.setFeedURL).not.toHaveBeenCalled();
  registerUpdater(() => true);
  const handler = mocks.handle.mock.calls.find(([channel]) => channel === 'sable-update-check');
  expect(handler).toBeDefined();
  expect(await handler?.[1]({ senderFrame: {} })).toBeNull();
  expect(mocks.checkForUpdates).not.toHaveBeenCalled();
});

test.each([
  ['2.0.0', 'latest/latest-linux.yml'],
  ['2.0.1-nightly.261102225045.g31a82d40d5f4', 'nightly/nightly-linux.yml'],
])('Flatpak %s reads the latest version from its own channel feed', async (version, feed) => {
  vi.stubEnv('FLATPAK_ID', 'moe.sable.client');
  vi.resetModules();
  mocks.app.getVersion = () => version;
  const fetch = vi.fn().mockResolvedValue({
    ok: true,
    text: () => Promise.resolve('version: 2.1.0\nfiles:\n  - url: sable.AppImage\n'),
  });
  vi.stubGlobal('fetch', fetch);
  const updater = await import('./updater');
  updater.registerUpdater(() => true);
  const handler = mocks.handle.mock.calls.find(
    ([channel]) => channel === 'sable-update-latest-version'
  );
  expect(await handler?.[1]({ senderFrame: {} })).toBe('2.1.0');
  expect(fetch).toHaveBeenCalledWith(expect.stringMatching(new RegExp(`/download/${feed}$`)), {
    cache: 'no-store',
  });
});

test('self-updating builds leave the latest version to the updater', async () => {
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  registerUpdater(() => true);
  const handler = mocks.handle.mock.calls.find(
    ([channel]) => channel === 'sable-update-latest-version'
  );
  expect(await handler?.[1]({ senderFrame: {} })).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
});
