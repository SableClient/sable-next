import { afterEach, expect, test, vi } from 'vitest';

import { registerGlobalShortcuts } from './global-shortcuts';

let cleanup: (() => void) | undefined;

afterEach(() => {
  cleanup?.();
  document.body.replaceChildren();
});

function pressInEditor(key: string, init: KeyboardEventInit): void {
  const editor = document.createElement('div');
  editor.contentEditable = 'true';
  document.body.append(editor);
  editor.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }));
}

test.each([
  ['ArrowUp', 'navigation.previousRoom'],
  ['ArrowDown', 'navigation.nextRoom'],
] as const)('alt+%s switches room from inside the composer', (key, id) => {
  const handler = vi.fn();
  cleanup = registerGlobalShortcuts({ [id]: handler });

  pressInEditor(key, { altKey: true });

  expect(handler).toHaveBeenCalledOnce();
});

test('a shortcut not allowed in editable fields stays out of the composer', () => {
  const handler = vi.fn();
  cleanup = registerGlobalShortcuts({ 'navigation.nextUnread': handler });

  pressInEditor('n', { altKey: true });

  expect(handler).not.toHaveBeenCalled();
});
