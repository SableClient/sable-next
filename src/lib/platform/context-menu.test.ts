// @vitest-environment happy-dom

import { afterEach, expect, test, vi } from 'vitest';
import { isTauri } from '@tauri-apps/api/core';
import { type as osType } from '@tauri-apps/plugin-os';
import { suppressNativeContextMenu } from './context-menu';

vi.mock('@tauri-apps/api/core', () => ({ isTauri: vi.fn() }));
vi.mock('@tauri-apps/plugin-os', () => ({ type: vi.fn() }));

afterEach(() => {
  vi.resetAllMocks();
  document.body.replaceChildren();
});

function rightClick(target: Element): MouseEvent {
  const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

test('the native menu is suppressed on desktop outside editable fields', () => {
  vi.mocked(isTauri).mockReturnValue(true);
  vi.mocked(osType).mockReturnValue('linux');
  const text = document.createElement('p');
  const input = document.createElement('input');
  const editor = document.createElement('div');
  editor.setAttribute('contenteditable', 'true');
  const inner = document.createElement('span');
  editor.append(inner);
  document.body.append(text, input, editor);

  const stop = suppressNativeContextMenu();
  expect(rightClick(text).defaultPrevented).toBe(true);
  expect(rightClick(input).defaultPrevented).toBe(false);
  expect(rightClick(inner).defaultPrevented).toBe(false);

  stop();
  expect(rightClick(text).defaultPrevented).toBe(false);
});

test.each([
  ['the web', false, 'linux'],
  ['android', true, 'android'],
  ['ios', true, 'ios'],
] as const)('the native menu is left alone on %s', (_name, tauri, platform) => {
  vi.mocked(isTauri).mockReturnValue(tauri);
  vi.mocked(osType).mockReturnValue(platform);
  const text = document.createElement('p');
  document.body.append(text);

  const stop = suppressNativeContextMenu();
  expect(rightClick(text).defaultPrevented).toBe(false);
  stop();
});
