// @vitest-environment happy-dom

import { afterEach, expect, test, vi } from 'vitest';

import { isLightColor, opaqueArgb, startSystemBarSync } from './system-bars';

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => true, invoke }));
vi.mock('@tauri-apps/plugin-os', () => ({ type: () => 'android' }));

afterEach(() => {
  invoke.mockReset();
  vi.restoreAllMocks();
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
  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);

  const stop = startSystemBarSync();
  reads.mockClear();

  for (let i = 0; i < 20; i++) {
    now += 1;
    window.dispatchEvent(new Event('resize'));
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  expect(reads.mock.calls.length).toBeLessThanOrEqual(2);

  stop();
});

test('a surface colour packs into an opaque java argb int', () => {
  expect(opaqueArgb('rgb(26, 28, 40)')).toBe(0xff1a1c28 | 0);
  expect(opaqueArgb('rgba(255, 255, 255, 0.5)')).toBe(-1);
});

test('the surface under the navigation bar becomes the window background', async () => {
  vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
    cb(0);
    return 1;
  });
  const surface = document.createElement('div');
  surface.style.backgroundColor = 'rgb(26, 28, 40)';
  document.body.append(surface);
  vi.spyOn(document, 'elementFromPoint').mockReturnValue(surface);
  invoke.mockResolvedValue(undefined);

  const stop = startSystemBarSync();
  await Promise.resolve();

  expect(invoke).toHaveBeenCalledWith('set_window_background', { color: 0xff1a1c28 | 0 });
  stop();
  surface.remove();
});
