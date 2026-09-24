// @vitest-environment happy-dom

import { flushSync, mount, unmount } from 'svelte';
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
  document.body.replaceChildren();
  vi.useRealTimers();
  vi.clearAllMocks();
  windows.supported = true;
});

function maximize(): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>('button[aria-label="Maximise"]');
  if (!button) throw new Error('maximize button not found');
  return button;
}

test('resting on maximize opens Snap Layouts and leaving hands it to the pointer', () => {
  vi.useFakeTimers();
  const instance = mount(TitleBar, { target: document.body, props: { kind: 'desktop' } });
  flushSync();

  maximize().dispatchEvent(new MouseEvent('mouseenter'));
  vi.advanceTimersByTime(600);
  expect(windows.show).not.toHaveBeenCalled();
  vi.advanceTimersByTime(20);
  expect(windows.show).toHaveBeenCalledOnce();

  maximize().dispatchEvent(new MouseEvent('mouseleave'));
  expect(windows.release).toHaveBeenCalledOnce();
  void unmount(instance);
});

test('passing over maximize without resting opens nothing and closes nothing', () => {
  vi.useFakeTimers();
  const instance = mount(TitleBar, { target: document.body, props: { kind: 'desktop' } });
  flushSync();

  maximize().dispatchEvent(new MouseEvent('mouseenter'));
  vi.advanceTimersByTime(300);
  maximize().dispatchEvent(new MouseEvent('mouseleave'));
  maximize().click();
  vi.advanceTimersByTime(1000);

  expect(windows.show).not.toHaveBeenCalled();
  expect(windows.release).not.toHaveBeenCalled();
  expect(windows.dismiss).not.toHaveBeenCalled();
  void unmount(instance);
});

test('clicking maximize with the flyout open closes it first', () => {
  vi.useFakeTimers();
  const instance = mount(TitleBar, { target: document.body, props: { kind: 'desktop' } });
  flushSync();

  maximize().dispatchEvent(new MouseEvent('mouseenter'));
  vi.advanceTimersByTime(620);
  maximize().click();

  expect(windows.dismiss).toHaveBeenCalledOnce();
  expect(windows.toggle).toHaveBeenCalledOnce();
  void unmount(instance);
});

test('stays out of the way where Windows Snap Layouts do not exist', () => {
  vi.useFakeTimers();
  windows.supported = false;
  const instance = mount(TitleBar, { target: document.body, props: { kind: 'desktop' } });
  flushSync();

  maximize().dispatchEvent(new MouseEvent('mouseenter'));
  vi.advanceTimersByTime(1000);

  expect(windows.show).not.toHaveBeenCalled();
  void unmount(instance);
});
