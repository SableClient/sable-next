import { afterEach, expect, test, vi } from 'vitest';

import { registerGlobalShortcuts } from './global-shortcuts';
import { rebind, resetAllBindings } from './bindings.svelte';

let cleanup: (() => void) | undefined;

afterEach(() => {
  cleanup?.();
  document.body.replaceChildren();
  resetAllBindings();
  vi.restoreAllMocks();
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

test.each([
  ['ArrowUp', 'navigation.cyclePreviousUnread'],
  ['ArrowDown', 'navigation.cycleNextUnread'],
] as const)('alt+shift+%s switches unread rooms from inside the composer', (key, id) => {
  const handler = vi.fn();
  const previousRoom = vi.fn();
  const nextRoom = vi.fn();
  cleanup = registerGlobalShortcuts({
    [id]: handler,
    'navigation.previousRoom': previousRoom,
    'navigation.nextRoom': nextRoom,
  });

  pressInEditor(key, { altKey: true, shiftKey: true });

  expect(handler).toHaveBeenCalledOnce();
  expect(previousRoom).not.toHaveBeenCalled();
  expect(nextRoom).not.toHaveBeenCalled();
});

test('a shortcut does nothing while a dialog is open', () => {
  const handler = vi.fn();
  cleanup = registerGlobalShortcuts({ 'navigation.nextRoom': handler });
  const dialog = document.createElement('div');
  dialog.setAttribute('role', 'dialog');
  document.body.append(dialog);
  const event = new KeyboardEvent('keydown', {
    key: 'ArrowDown',
    altKey: true,
    bubbles: true,
    cancelable: true,
  });

  dialog.dispatchEvent(event);

  expect(handler).not.toHaveBeenCalled();
  expect(event.defaultPrevented).toBe(false);
});

test('a shortcut handled by the focused field does not switch rooms', () => {
  const handler = vi.fn();
  cleanup = registerGlobalShortcuts({ 'navigation.nextRoom': handler });
  const input = document.createElement('input');
  input.addEventListener('keydown', (event) => {
    event.preventDefault();
  });
  document.body.append(input);
  input.dispatchEvent(
    new KeyboardEvent('keydown', {
      key: 'ArrowDown',
      altKey: true,
      bubbles: true,
      cancelable: true,
    })
  );
  expect(handler).not.toHaveBeenCalled();
});

function holdShortcut() {
  const press = vi.fn();
  const release = vi.fn();
  cleanup = registerGlobalShortcuts({ 'call.pushToTalk': { press, release } });
  return { press, release };
}

function key(
  type: 'keydown' | 'keyup',
  init: KeyboardEventInit = {},
  target: EventTarget = window
) {
  const event = new KeyboardEvent(type, {
    key: 'T',
    code: 'KeyT',
    ctrlKey: true,
    shiftKey: true,
    bubbles: true,
    cancelable: true,
    ...init,
  });
  target.dispatchEvent(event);
  return event;
}

test('push-to-talk ignores repeats and releases once', () => {
  const { press, release } = holdShortcut();
  expect(key('keydown').defaultPrevented).toBe(true);
  key('keydown', { repeat: true });
  expect(press).toHaveBeenCalledOnce();
  expect(release).not.toHaveBeenCalled();
  key('keyup');
  key('keyup');
  expect(release).toHaveBeenCalledOnce();
});

test.each([
  { key: 'Control', code: 'ControlLeft', ctrlKey: false },
  { key: 'Shift', code: 'ShiftLeft', shiftKey: false },
])('releasing $key first ends the hold', (init) => {
  const { release } = holdShortcut();
  key('keydown');
  key('keyup', init);
  expect(release).toHaveBeenCalledOnce();
});

test('releasing an unrelated key leaves the hold active', () => {
  const { release } = holdShortcut();
  key('keydown');
  key('keyup', { key: 'x', code: 'KeyX' });
  expect(release).not.toHaveBeenCalled();
});

test.each(['blur', 'hidden', 'cleanup'] as const)('%s releases an active hold', (event) => {
  const { release } = holdShortcut();
  key('keydown');
  if (event === 'blur') window.dispatchEvent(new Event('blur'));
  else if (event === 'hidden') {
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true);
    document.dispatchEvent(new Event('visibilitychange'));
  } else cleanup?.();
  key('keyup');
  expect(release).toHaveBeenCalledOnce();
});

test('keyup is handled even when a dialog opens and consumes the event', () => {
  const { release } = holdShortcut();
  key('keydown');
  const dialog = document.createElement('div');
  dialog.setAttribute('role', 'dialog');
  dialog.addEventListener('keyup', (event) => {
    event.preventDefault();
    event.stopPropagation();
  });
  document.body.append(dialog);
  key('keyup', {}, dialog);
  expect(release).toHaveBeenCalledOnce();
});

test('rebinding while held still releases the original key', () => {
  const { press, release } = holdShortcut();
  rebind('call.pushToTalk', 'alt+space');
  key('keydown', { key: ' ', code: 'Space', ctrlKey: false, shiftKey: false, altKey: true });
  expect(press).toHaveBeenCalledOnce();
  rebind('call.pushToTalk', 'alt+x');
  key('keyup', { key: ' ', code: 'Space', ctrlKey: false, shiftKey: false, altKey: true });
  expect(release).toHaveBeenCalledOnce();
});

test('unmodified hold shortcuts do not intercept typing', () => {
  const { press } = holdShortcut();
  rebind('call.pushToTalk', 'space');
  const input = document.createElement('textarea');
  document.body.append(input);
  const init = { key: ' ', code: 'Space', ctrlKey: false, shiftKey: false };
  expect(key('keydown', init, input).defaultPrevented).toBe(false);
  expect(press).not.toHaveBeenCalled();
  key('keydown', init);
  expect(press).toHaveBeenCalledOnce();
});

test('a dialog or composing event cannot start a hold', () => {
  const { press } = holdShortcut();
  key('keydown', { isComposing: true });
  const dialog = document.createElement('div');
  dialog.setAttribute('role', 'dialog');
  document.body.append(dialog);
  key('keydown');
  expect(press).not.toHaveBeenCalled();
});

test('a disabled shortcut leaves the key to the browser', () => {
  const handler = vi.fn();
  cleanup = registerGlobalShortcuts({ 'call.pushToTalk': handler }, () => false);

  const event = new KeyboardEvent('keydown', {
    key: 'T',
    ctrlKey: true,
    shiftKey: true,
    cancelable: true,
  });
  window.dispatchEvent(event);

  expect(handler).not.toHaveBeenCalled();
  expect(event.defaultPrevented).toBe(false);
});
