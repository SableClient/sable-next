import { afterEach, expect, test, vi } from 'vitest';

import {
  customTitleBarDefault,
  hardwareVideoEncodeDefault,
  supportsTray,
  titleBarKind,
  watchMaximized,
  watchHiddenToTray,
} from './window-decorations.js';

function installElectron(platform: string, maximized = false) {
  const unsubscribe = vi.fn();
  (globalThis as { sableElectron?: unknown }).sableElectron = {
    platform,
    isWindowMaximized: () => Promise.resolve(maximized),
    onWindowMaximized: () => unsubscribe,
  };
  return unsubscribe;
}

afterEach(() => {
  delete (globalThis as { sableElectron?: unknown }).sableElectron;
});

test.each([
  ['darwin', 'mac'],
  ['win32', 'desktop'],
  ['linux', 'desktop'],
])('Electron on %s draws the %s title bar', (platform, kind) => {
  installElectron(platform);

  expect(titleBarKind(true)).toBe(kind);
  expect(titleBarKind(false)).toBeNull();
});

test('Electron defaults to the custom title bar only on Windows', () => {
  installElectron('win32');
  expect(customTitleBarDefault()).toBe(true);
  installElectron('linux');
  expect(customTitleBarDefault()).toBe(false);
});

test('hardware video encoding defaults to off only on Linux', () => {
  installElectron('linux');
  expect(hardwareVideoEncodeDefault()).toBe(false);
  installElectron('darwin');
  expect(hardwareVideoEncodeDefault()).toBe(true);
});

test('an Electron window reports its maximised state and stops listening', async () => {
  const unsubscribe = installElectron('linux', true);
  const changed = vi.fn();

  const stop = await watchMaximized(changed);
  stop();

  expect(changed).toHaveBeenCalledWith(true);
  expect(unsubscribe).toHaveBeenCalledOnce();
});

test.each([
  ['win32', true],
  ['linux', true],
  ['darwin', false],
])('Electron tray settings are available on %s: %s', (platform, supported) => {
  installElectron(platform);
  expect(supportsTray()).toBe(supported);
});

test('Electron hidden-to-tray notifications can be subscribed and removed', () => {
  const unsubscribe = vi.fn();
  const onWindowHiddenToTray = vi.fn().mockReturnValue(unsubscribe);
  vi.stubGlobal('sableElectron', { platform: 'win32', onWindowHiddenToTray });
  const hidden = vi.fn();
  const stop = watchHiddenToTray(hidden);
  expect(onWindowHiddenToTray).toHaveBeenCalledWith(hidden);
  stop();
  expect(unsubscribe).toHaveBeenCalledOnce();
});
