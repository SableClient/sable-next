import { afterEach, expect, it, vi } from 'vitest';

import { setUnreadBadge } from './badge.js';
import type { ElectronBridge } from './electron';

afterEach(() => {
  vi.unstubAllGlobals();
});

it('sends the count to Electron without the web Badging API', async () => {
  const setBadge = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('sableElectron', {
    platform: 'linux',
    setBadge,
  } satisfies Pick<ElectronBridge, 'platform' | 'setBadge'>);
  vi.stubGlobal('navigator', {});

  await setUnreadBadge(3);
  await setUnreadBadge(0);
  expect(setBadge.mock.calls).toEqual([
    [3, null],
    [0, null],
  ]);
});

it('sets and clears the browser badge', async () => {
  const setAppBadge = vi.fn().mockResolvedValue(undefined);
  const clearAppBadge = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal('navigator', { setAppBadge, clearAppBadge });

  await setUnreadBadge(3);
  await setUnreadBadge(0);
  expect(setAppBadge).toHaveBeenCalledWith(3);
  expect(clearAppBadge).toHaveBeenCalledOnce();
});
