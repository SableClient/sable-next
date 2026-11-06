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

it('sets the native iOS badge', async () => {
  vi.resetModules();
  const invoke = vi.fn().mockResolvedValue(undefined);
  vi.doMock('@tauri-apps/api/core', () => ({ invoke, isTauri: () => true }));
  vi.doMock('@tauri-apps/plugin-os', () => ({ type: () => 'ios' }));
  const { setUnreadBadge: set } = await import('./badge.js');
  await set(3);
  await set(0);
  expect(invoke.mock.calls).toEqual([
    ['set_badge_count', { count: 3 }],
    ['set_badge_count', { count: 0 }],
  ]);
  vi.doUnmock('@tauri-apps/api/core');
  vi.doUnmock('@tauri-apps/plugin-os');
});
