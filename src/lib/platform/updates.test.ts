// @vitest-environment happy-dom

import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  isTauri: vi.fn(),
  osType: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ isTauri: mocks.isTauri }));
vi.mock('@tauri-apps/plugin-os', () => ({ type: mocks.osType }));

beforeEach(() => {
  mocks.isTauri.mockReturnValue(true);
  mocks.osType.mockReturnValue('android');
  vi.stubEnv('VITE_APP_VERSION', '1.2.3');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function load() {
  return import('./updates');
}

test.each(['android', 'ios'])(
  'mobile checks the release manifest on %s without installing anything',
  async (os) => {
    mocks.osType.mockReturnValue(os);
    const fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => ({ version: '1.3.0' }),
    });
    vi.stubGlobal('fetch', fetch);

    const { checkForMobileUpdate, updatePlatform } = await load();

    expect(updatePlatform()).toBe('mobile');
    await expect(checkForMobileUpdate()).resolves.toBe(true);
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining('/releases/download/latest/latest.json'),
      { cache: 'no-store' }
    );
  }
);

test('mobile reports current when the manifest is not newer', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: () => ({ version: '1.2.2' }),
    })
  );

  const { checkForMobileUpdate } = await load();

  await expect(checkForMobileUpdate()).resolves.toBe(false);
});
