// @vitest-environment happy-dom

import { fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, expect, test, vi } from 'vitest';

const windows = vi.hoisted(() => ({
  minimize: vi.fn(),
  toggle: vi.fn(),
  close: vi.fn(),
}));

vi.mock('#lib/platform/window-decorations.js', () => ({
  customTitleBarDefault: () => false,
  hardwareVideoEncodeDefault: () => false,
  closeWindow: windows.close,
  minimizeWindow: windows.minimize,
  toggleMaximizeWindow: windows.toggle,
  watchMaximized: () => Promise.resolve(() => {}),
}));

import TitleBar from './TitleBar.svelte';

afterEach(() => {
  vi.clearAllMocks();
});

test('the window controls drive the window', async () => {
  render(TitleBar, { kind: 'desktop' });

  await fireEvent.click(screen.getByRole('button', { name: 'Minimise' }));
  await fireEvent.click(screen.getByRole('button', { name: 'Maximise' }));
  await fireEvent.click(screen.getByRole('button', { name: 'Close' }));

  expect(windows.minimize).toHaveBeenCalledOnce();
  expect(windows.toggle).toHaveBeenCalledOnce();
  expect(windows.close).toHaveBeenCalledOnce();
});

test('the mac title bar leaves the window controls to the system', () => {
  render(TitleBar, { kind: 'mac' });

  expect(screen.queryByRole('button', { name: 'Maximise' })).toBeNull();
});
