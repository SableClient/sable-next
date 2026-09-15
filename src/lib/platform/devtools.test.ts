import { afterEach, expect, test, vi } from 'vitest';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { type as osType } from '@tauri-apps/plugin-os';
import { trackInspectorShortcut } from './devtools';

vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn(), isTauri: vi.fn() }));
vi.mock('@tauri-apps/plugin-os', () => ({ type: vi.fn() }));

afterEach(() => {
  vi.resetAllMocks();
});

function pressF12(init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key: 'F12', cancelable: true, ...init });
  window.dispatchEvent(event);
  return event;
}

test('F12 toggles the inspector on desktop', () => {
  vi.mocked(isTauri).mockReturnValue(true);
  vi.mocked(osType).mockReturnValue('linux');
  vi.mocked(invoke).mockResolvedValue(undefined);

  const stop = trackInspectorShortcut();
  const event = pressF12();
  expect(invoke).toHaveBeenCalledWith('toggle_devtools');
  expect(event.defaultPrevented).toBe(true);

  stop();
  pressF12();
  expect(invoke).toHaveBeenCalledTimes(1);
});

test('a modified F12 is left to the page', () => {
  vi.mocked(isTauri).mockReturnValue(true);
  vi.mocked(osType).mockReturnValue('linux');

  const stop = trackInspectorShortcut();
  pressF12({ shiftKey: true });
  expect(invoke).not.toHaveBeenCalled();
  stop();
});

test.each([
  ['the web', false, 'linux'],
  ['android', true, 'android'],
  ['ios', true, 'ios'],
] as const)('there is no shortcut on %s', (_name, tauri, platform) => {
  vi.mocked(isTauri).mockReturnValue(tauri);
  vi.mocked(osType).mockReturnValue(platform);

  const stop = trackInspectorShortcut();
  pressF12();
  expect(invoke).not.toHaveBeenCalled();
  stop();
});
