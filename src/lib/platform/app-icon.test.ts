import { afterEach, expect, test, vi } from 'vitest';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { type as osType } from '@tauri-apps/plugin-os';
import { loadAppIcons, setAppIcon } from './app-icon';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: vi.fn() }));
vi.mock('@tauri-apps/plugin-os', () => ({ type: vi.fn() }));

afterEach(() => {
  vi.resetAllMocks();
});

test('the web and desktop have no icons to offer', async () => {
  vi.mocked(isTauri).mockReturnValue(false);
  expect(await loadAppIcons()).toBeNull();
  vi.mocked(isTauri).mockReturnValue(true);
  vi.mocked(osType).mockReturnValue('linux');
  expect(await loadAppIcons()).toBeNull();
  expect(invoke).not.toHaveBeenCalled();
});

test.each(['ios', 'android'] as const)('lists the icons on %s', async (platform) => {
  vi.mocked(isTauri).mockReturnValue(true);
  vi.mocked(osType).mockReturnValue(platform);
  vi.mocked(invoke).mockImplementation((command) =>
    Promise.resolve(command === 'plugin:app-icon|get_available_icons' ? ['pride'] : 'pride')
  );
  expect(await loadAppIcons()).toEqual({ available: ['pride'], current: 'pride' });
});

test('a missing plugin hides the picker', async () => {
  vi.mocked(isTauri).mockReturnValue(true);
  vi.mocked(osType).mockReturnValue('ios');
  vi.mocked(invoke).mockRejectedValue(new Error('plugin not found'));
  expect(await loadAppIcons()).toBeNull();
});

test('setting an icon passes it through the plugin request', async () => {
  vi.mocked(invoke).mockResolvedValue(undefined);
  await setAppIcon(null);
  expect(invoke).toHaveBeenCalledWith('plugin:app-icon|set_icon', { request: { icon: null } });
});
