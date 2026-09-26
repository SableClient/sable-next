// @vitest-environment happy-dom

import { fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, expect, test, vi } from 'vitest';

const windows = vi.hoisted(() => ({
  supported: true,
  show: vi.fn(() => Promise.resolve()),
  release: vi.fn(() => Promise.resolve()),
  dismiss: vi.fn(() => Promise.resolve()),
  toggle: vi.fn(() => Promise.resolve()),
}));

vi.mock('#lib/platform/window-decorations.js', () => ({
  customTitleBarDefault: () => false,
  closeWindow: vi.fn(() => Promise.resolve()),
  minimizeWindow: vi.fn(() => Promise.resolve()),
  startWindowResize: vi.fn(() => Promise.resolve()),
  toggleMaximizeWindow: windows.toggle,
  watchMaximized: () => Promise.resolve(() => {}),
  supportsSnapLayouts: () => windows.supported,
  showSnapLayouts: windows.show,
  releaseSnapLayouts: windows.release,
  dismissSnapLayouts: windows.dismiss,
}));

import TitleBar from './TitleBar.svelte';

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  windows.supported = true;
});

const maximize = () => screen.getByRole('button', { name: 'Maximise' });

test('resting on maximize opens Snap Layouts and leaving hands it to the pointer', () => {
  vi.useFakeTimers();
  render(TitleBar, { kind: 'desktop' });

  void fireEvent.mouseEnter(maximize());
  vi.advanceTimersByTime(600);
  expect(windows.show).not.toHaveBeenCalled();
  vi.advanceTimersByTime(20);
  expect(windows.show).toHaveBeenCalledOnce();

  void fireEvent.mouseLeave(maximize());
  expect(windows.release).toHaveBeenCalledOnce();
});

test('passing over maximize without resting opens nothing and closes nothing', () => {
  vi.useFakeTimers();
  render(TitleBar, { kind: 'desktop' });

  void fireEvent.mouseEnter(maximize());
  vi.advanceTimersByTime(300);
  void fireEvent.mouseLeave(maximize());
  void fireEvent.click(maximize());
  vi.advanceTimersByTime(1000);

  expect(windows.show).not.toHaveBeenCalled();
  expect(windows.release).not.toHaveBeenCalled();
  expect(windows.dismiss).not.toHaveBeenCalled();
});

test('clicking maximize with the flyout open closes it first', () => {
  vi.useFakeTimers();
  render(TitleBar, { kind: 'desktop' });

  void fireEvent.mouseEnter(maximize());
  vi.advanceTimersByTime(620);
  void fireEvent.click(maximize());

  expect(windows.dismiss).toHaveBeenCalledOnce();
  expect(windows.toggle).toHaveBeenCalledOnce();
});

test('stays out of the way where Windows Snap Layouts do not exist', () => {
  vi.useFakeTimers();
  windows.supported = false;
  render(TitleBar, { kind: 'desktop' });

  void fireEvent.mouseEnter(maximize());
  vi.advanceTimersByTime(1000);

  expect(windows.show).not.toHaveBeenCalled();
});
