import { expect, test, vi } from 'vitest';

import { isLightColor } from './system-bars';

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => false, invoke: vi.fn() }));
vi.mock('@tauri-apps/plugin-os', () => ({ type: () => 'android' }));

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
