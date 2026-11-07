// @vitest-environment happy-dom

import { afterEach, beforeEach, expect, test, vi } from 'vitest';

const check = vi.hoisted(() => vi.fn<() => Promise<boolean>>());
vi.mock('$app/state', () => ({ updated: { check } }));

import { ModelAssetError } from '#lib/model/model.js';
import {
  installDynamicImportRecovery,
  isReloadingForNewBuild,
  recoverStaleAsset,
} from './dynamic-import-recovery.js';

beforeEach(() => {
  check.mockResolvedValue(true);
});

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
  vi.restoreAllMocks();
  check.mockReset();
});

test.each([
  'Failed to fetch dynamically imported module',
  'Error loading dynamically imported module',
  'Importing a module script failed.',
  'Unable to preload CSS for https://next.sable.moe/_app/immutable/assets/TextArea.css',
])('reloads once for %s when the build is stale', async (message) => {
  const reload = vi.fn();
  vi.stubGlobal('location', { reload });
  vi.spyOn(Date, 'now').mockReturnValue(1_000_000);

  await expect(recoverStaleAsset(new Error(message))).resolves.toBe(true);

  expect(reload).toHaveBeenCalledOnce();
});

test('does not reload for a transient failure on an unchanged build', async () => {
  const reload = vi.fn();
  vi.stubGlobal('location', { reload });
  check.mockResolvedValue(false);

  await expect(
    recoverStaleAsset(new Error('Failed to fetch dynamically imported module'))
  ).resolves.toBe(false);

  expect(reload).not.toHaveBeenCalled();
  expect(sessionStorage.getItem('sable:dynamic-import-reload')).toBeNull();
});

test('does not reload again inside the recovery window', async () => {
  const reload = vi.fn();
  vi.stubGlobal('location', { reload });
  sessionStorage.setItem('sable:dynamic-import-reload', '1000000');
  vi.spyOn(Date, 'now').mockReturnValue(1_000_001);

  await expect(
    recoverStaleAsset(new Error('Failed to fetch dynamically imported module'))
  ).resolves.toBe(false);

  expect(reload).not.toHaveBeenCalled();
  expect(check).not.toHaveBeenCalled();
});

test('ignores errors that are not dynamic import failures', async () => {
  const reload = vi.fn();
  vi.stubGlobal('location', { reload });

  await expect(recoverStaleAsset({ message: 'Internal Error', status: 500 })).resolves.toBe(false);
  await expect(recoverStaleAsset(new Error('navigation failed'))).resolves.toBe(false);

  expect(check).not.toHaveBeenCalled();
  expect(reload).not.toHaveBeenCalled();
});

test('does not reload when storage cannot be written', async () => {
  const reload = vi.fn();
  vi.stubGlobal('location', { reload });
  vi.stubGlobal('sessionStorage', {
    getItem: () => null,
    setItem: () => {
      throw new Error('denied');
    },
  });

  await expect(
    recoverStaleAsset(new Error('Failed to fetch dynamically imported module'))
  ).resolves.toBe(false);

  expect(reload).not.toHaveBeenCalled();
});

test('the rejection listener reloads on a stale build and leaves the rejection observable', async () => {
  const reload = vi.fn();
  vi.stubGlobal('location', { reload });
  const stop = installDynamicImportRecovery();
  const event = Object.assign(new Event('unhandledrejection', { cancelable: true }), {
    reason: new Error('Failed to fetch dynamically imported module'),
  });

  window.dispatchEvent(event);
  await vi.waitFor(() => {
    expect(reload).toHaveBeenCalledOnce();
  });

  expect(event.defaultPrevented).toBe(false);
  stop();
});

test('reloads when the model wasm came back as a page, and stops reporting that failure', async () => {
  const reload = vi.fn();
  vi.stubGlobal('location', { reload });
  const error = new ModelAssetError(200);

  await expect(recoverStaleAsset(error)).resolves.toBe(true);

  expect(reload).toHaveBeenCalledOnce();
  expect(isReloadingForNewBuild(error)).toBe(true);
  expect(isReloadingForNewBuild(new Error('navigation failed'))).toBe(false);
});
