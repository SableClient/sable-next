import { afterEach, expect, test, vi } from 'vitest';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { type as osType } from '@tauri-apps/plugin-os';
import { hapticFeedback } from './haptics';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: vi.fn() }));
vi.mock('@tauri-apps/plugin-os', () => ({ type: vi.fn() }));

afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});

test.each(['ios', 'android'] as const)('uses native feedback on %s', async (platform) => {
  vi.mocked(isTauri).mockReturnValue(true);
  vi.mocked(osType).mockReturnValue(platform);
  vi.mocked(invoke).mockResolvedValue(undefined);
  const vibrate = vi.fn();
  vi.stubGlobal('navigator', { vibrate });
  hapticFeedback('medium');
  await Promise.resolve();
  expect(invoke).toHaveBeenCalledWith('haptic_feedback', { strong: true });
  expect(vibrate).not.toHaveBeenCalled();
});

test('falls back to browser vibration when the native command is unavailable', async () => {
  vi.mocked(isTauri).mockReturnValue(true);
  vi.mocked(osType).mockReturnValue('ios');
  vi.mocked(invoke).mockRejectedValue(new Error('older shell'));
  const vibrate = vi.fn();
  vi.stubGlobal('navigator', { vibrate });
  hapticFeedback();
  await Promise.resolve();
  expect(vibrate).toHaveBeenCalledWith(10);
});

test('unsupported browsers and rejected vibration do not interrupt gestures', () => {
  vi.stubGlobal('navigator', {});
  expect(() => {
    hapticFeedback();
  }).not.toThrow();
  vi.stubGlobal('navigator', {
    vibrate: () => {
      throw new Error('denied');
    },
  });
  expect(() => {
    hapticFeedback();
  }).not.toThrow();
});
