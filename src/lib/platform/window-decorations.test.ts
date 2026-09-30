import { beforeEach, expect, test, vi } from 'vitest';

const native = vi.hoisted(() => ({
  isTauri: true,
  focusChanged: null as ((event: { payload: boolean }) => void) | null,
  isFocused: vi.fn<() => Promise<boolean>>(),
  isMinimized: vi.fn<() => Promise<boolean>>(),
  isVisible: vi.fn<() => Promise<boolean>>(),
  unlisten: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ isTauri: () => native.isTauri }));
vi.mock('@tauri-apps/plugin-os', () => ({ type: () => 'linux' }));
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({
    isFocused: native.isFocused,
    isMinimized: native.isMinimized,
    isVisible: native.isVisible,
    onFocusChanged: (callback: (event: { payload: boolean }) => void) => {
      native.focusChanged = callback;
      return Promise.resolve(native.unlisten);
    },
  }),
}));

import { watchWindowFocus } from './window-decorations.js';

beforeEach(() => {
  native.isTauri = true;
  native.focusChanged = null;
  native.unlisten.mockReset();
  native.isFocused.mockReset().mockResolvedValue(true);
  native.isMinimized.mockReset().mockResolvedValue(false);
  native.isVisible.mockReset().mockResolvedValue(true);
});

test.each([
  { focused: false, minimized: false, visible: true },
  { focused: true, minimized: true, visible: true },
  { focused: true, minimized: false, visible: false },
])('starts inactive for a background window: %j', async ({ focused, minimized, visible }) => {
  native.isFocused.mockResolvedValue(focused);
  native.isMinimized.mockResolvedValue(minimized);
  native.isVisible.mockResolvedValue(visible);
  const changed = vi.fn();
  const stop = await watchWindowFocus(changed);

  expect(changed).toHaveBeenCalled();
  expect(changed.mock.calls.every(([active]) => active === false)).toBe(true);
  native.focusChanged?.({ payload: true });
  expect(changed).toHaveBeenLastCalledWith(true);
  stop();
  expect(native.unlisten).toHaveBeenCalledOnce();
});

test('initial focus query cannot overwrite a newer blur event', async () => {
  let resolve!: (focused: boolean) => void;
  native.isFocused.mockImplementation(
    () =>
      new Promise<boolean>((next) => {
        resolve = next;
      })
  );
  const changed = vi.fn();
  const watching = watchWindowFocus(changed);
  await vi.waitFor(() => {
    expect(native.isFocused).toHaveBeenCalled();
  });

  native.focusChanged?.({ payload: false });
  resolve(true);
  const stop = await watching;

  expect(changed).toHaveBeenLastCalledWith(false);
  stop();
});

test('does not watch a native window in the browser', async () => {
  native.isTauri = false;
  const changed = vi.fn();
  const stop = await watchWindowFocus(changed);

  expect(changed).not.toHaveBeenCalled();
  expect(native.isFocused).not.toHaveBeenCalled();
  stop();
});

test('reads the initial foreground focus and follows later blur events', async () => {
  const changed = vi.fn();
  const stop = await watchWindowFocus(changed);

  expect(changed).toHaveBeenLastCalledWith(true);
  native.focusChanged?.({ payload: false });
  expect(changed).toHaveBeenLastCalledWith(false);
  stop();
});

test('removes the listener if the initial window query fails', async () => {
  native.isFocused.mockRejectedValue(new Error('window unavailable'));

  await expect(watchWindowFocus(vi.fn())).rejects.toThrow('window unavailable');
  expect(native.unlisten).toHaveBeenCalledOnce();
});
