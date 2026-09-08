// @vitest-environment happy-dom

import { afterEach, expect, test, vi } from 'vitest';

import {
  installDynamicImportRecovery,
  recoverStaleDynamicImport,
} from './dynamic-import-recovery.js';

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
  vi.restoreAllMocks();
});

test.each([
  'Failed to fetch dynamically imported module',
  'Error loading dynamically imported module',
])('reloads once for %s rejected outside SvelteKit handleError', (message) => {
  const reload = vi.fn();
  vi.stubGlobal('location', { reload });
  vi.spyOn(Date, 'now').mockReturnValue(1_000_000);
  const stop = installDynamicImportRecovery();
  const event = Object.assign(new Event('unhandledrejection', { cancelable: true }), {
    reason: new Error(message),
  });

  window.dispatchEvent(event);

  expect(reload).toHaveBeenCalledOnce();
  expect(event.defaultPrevented).toBe(true);
  stop();
});

test('does not reload again inside the recovery window', () => {
  const reload = vi.fn();
  vi.stubGlobal('location', { reload });
  sessionStorage.setItem('sable:dynamic-import-reload', '1000000');
  vi.spyOn(Date, 'now').mockReturnValue(1_000_001);
  const stop = installDynamicImportRecovery();
  const event = Object.assign(new Event('unhandledrejection', { cancelable: true }), {
    reason: new Error('Failed to fetch dynamically imported module'),
  });

  window.dispatchEvent(event);

  expect(reload).not.toHaveBeenCalled();
  expect(event.defaultPrevented).toBe(false);
  stop();
});

test('leaves a navigation 500 rejection observable', () => {
  const reload = vi.fn();
  vi.stubGlobal('location', { reload });
  const stop = installDynamicImportRecovery();
  const event = Object.assign(new Event('unhandledrejection', { cancelable: true }), {
    reason: { message: 'Internal Error', status: 500 },
  });

  window.dispatchEvent(event);

  expect(reload).not.toHaveBeenCalled();
  expect(event.defaultPrevented).toBe(false);
  stop();
});

test('preserves a stale-import rejection when storage cannot be written', () => {
  const reload = vi.fn();
  vi.stubGlobal('location', { reload });
  vi.stubGlobal('sessionStorage', {
    getItem: () => null,
    setItem: () => {
      throw new Error('denied');
    },
  });
  const stop = installDynamicImportRecovery();
  const event = Object.assign(new Event('unhandledrejection', { cancelable: true }), {
    reason: new Error('Failed to fetch dynamically imported module'),
  });

  window.dispatchEvent(event);

  expect(reload).not.toHaveBeenCalled();
  expect(event.defaultPrevented).toBe(false);
  stop();
});

test('does not read denied storage for an unrelated error', () => {
  const storage = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
  Object.defineProperty(globalThis, 'sessionStorage', {
    configurable: true,
    get: () => {
      throw new Error('denied');
    },
  });

  try {
    expect(recoverStaleDynamicImport(new Error('navigation failed'))).toBe(false);
  } finally {
    if (storage) Object.defineProperty(globalThis, 'sessionStorage', storage);
  }
});
