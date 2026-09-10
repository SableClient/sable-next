// @vitest-environment happy-dom

import { afterEach, expect, test, vi } from 'vitest';

import { isLightColor, startSystemBarSync } from './system-bars';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke }));
vi.mock('@tauri-apps/plugin-os', () => ({ type: () => 'android' }));

afterEach(() => {
  invoke.mockReset();
  vi.useRealTimers();
});

test('a light surface asks for dark icons', () => {
  expect(isLightColor('rgb(255, 255, 255)')).toBe(true);
});

test('a dark surface asks for light icons', () => {
  expect(isLightColor('rgb(18, 17, 22)')).toBe(false);
});

test('an unreadable color falls back to dark icons', () => {
  expect(isLightColor('transparent')).toBe(true);
  expect(isLightColor('')).toBe(true);
});

test('repeated triggers sample on an interval, not once per trigger', async () => {
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
    setTimeout(() => {
      cb(0);
    }, 0);
    return 1;
  });
  const reads = vi.spyOn(document, 'elementFromPoint').mockReturnValue(null);

  const stop = startSystemBarSync();
  reads.mockClear();

  for (let i = 0; i < 20; i++) {
    window.dispatchEvent(new Event('resize'));
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  expect(reads.mock.calls.length).toBeLessThanOrEqual(2);

  stop();
});
