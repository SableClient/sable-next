import { expect, test } from 'vitest';

import {
  findShortcutConflicts,
  formatBinding,
  isEditableTarget,
  isDialogOpen,
  matchesBinding,
  parseBinding,
} from './binding';

function event(overrides: Partial<Parameters<typeof matchesBinding>[1]> = {}) {
  return {
    key: 'a',
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    ...overrides,
  };
}

test('parses a plain key with no modifiers', () => {
  expect(parseBinding('f')).toEqual({
    key: 'f',
    mod: false,
    ctrl: false,
    meta: false,
    alt: false,
    shift: false,
  });
});

test('parses combined modifiers', () => {
  expect(parseBinding('mod+shift+n')).toEqual({
    key: 'n',
    mod: true,
    ctrl: false,
    meta: false,
    alt: false,
    shift: true,
  });
});

test('resolves aliases for arrow and space keys', () => {
  expect(parseBinding('alt+shift+down').key).toBe('arrowdown');
  expect(parseBinding('space').key).toBe(' ');
});

test('mod matches ctrl on non-mac platforms', () => {
  expect(matchesBinding('mod+k', event({ key: 'k', ctrlKey: true }), false)).toBe(true);
  expect(matchesBinding('mod+k', event({ key: 'k', metaKey: true }), false)).toBe(false);
});

test('mod matches meta on mac', () => {
  expect(matchesBinding('mod+k', event({ key: 'k', metaKey: true }), true)).toBe(true);
  expect(matchesBinding('mod+k', event({ key: 'k', ctrlKey: true }), true)).toBe(false);
});

test('an unrelated modifier held down blocks the match', () => {
  expect(matchesBinding('mod+k', event({ key: 'k', ctrlKey: true, altKey: true }), false)).toBe(
    false
  );
});

test('a letter binding ignores shiftKey, since the reported key already reflects it', () => {
  expect(matchesBinding('mod+f', event({ key: 'f', ctrlKey: true, shiftKey: true }), false)).toBe(
    true
  );
});

test('mod+shift+n matches the uppercase key browsers report for it', () => {
  expect(
    matchesBinding('mod+shift+n', event({ key: 'N', ctrlKey: true, shiftKey: true }), false)
  ).toBe(true);
});

test('a named key binding requires an exact shiftKey match', () => {
  expect(matchesBinding('alt+shift+down', event({ key: 'ArrowDown', altKey: true }), false)).toBe(
    false
  );
  expect(
    matchesBinding(
      'alt+shift+down',
      event({ key: 'ArrowDown', altKey: true, shiftKey: true }),
      false
    )
  ).toBe(true);
});

test('a plain text input is editable', () => {
  const input = document.createElement('input');
  document.body.append(input);
  expect(isEditableTarget(input)).toBe(true);
  input.remove();
});

test('a contenteditable div is editable', () => {
  const div = document.createElement('div');
  div.contentEditable = 'true';
  document.body.append(div);
  expect(isEditableTarget(div)).toBe(true);
  div.remove();
});

test('a plain button is not editable', () => {
  const button = document.createElement('button');
  expect(isEditableTarget(button)).toBe(false);
});

test('a null target is not editable', () => {
  expect(isEditableTarget(null)).toBe(false);
});

test('no dialog open reports false', () => {
  expect(isDialogOpen(document)).toBe(false);
});

test('an open dialog is detected by its content class', () => {
  const dialog = document.createElement('div');
  dialog.className = 'sable-dialog-content';
  document.body.append(dialog);
  expect(isDialogOpen(document)).toBe(true);
  dialog.remove();
});

test('identical bindings in the same scope conflict', () => {
  const conflicts = findShortcutConflicts(
    [
      { id: 'a', binding: 'mod+shift+n', scope: 'global' },
      { id: 'b', binding: 'shift+mod+n', scope: 'global' },
    ],
    false
  );

  expect(conflicts).toHaveLength(1);
  expect(conflicts[0]?.[0].id).toBe('a');
  expect(conflicts[0]?.[1].id).toBe('b');
});

test('the same binding in different scopes does not conflict', () => {
  const conflicts = findShortcutConflicts(
    [
      { id: 'a', binding: 'mod+f', scope: 'global' },
      { id: 'b', binding: 'mod+f', scope: 'composer' },
    ],
    false
  );

  expect(conflicts).toHaveLength(0);
});

test('mod resolves to the platform modifier before comparing', () => {
  const conflicts = findShortcutConflicts(
    [
      { id: 'a', binding: 'mod+k', scope: 'global' },
      { id: 'b', binding: 'ctrl+k', scope: 'global' },
    ],
    false
  );

  expect(conflicts).toHaveLength(1);
});

test('formats a mac binding with symbols', () => {
  expect(formatBinding('mod+shift+n', true)).toBe('⌘+⇧+N');
});

test('formats a non-mac binding with words', () => {
  expect(formatBinding('mod+shift+n', false)).toBe('Ctrl+Shift+N');
});

test('formats named keys by their display label', () => {
  expect(formatBinding('alt+shift+down', false)).toBe('Alt+Shift+Down');
});
