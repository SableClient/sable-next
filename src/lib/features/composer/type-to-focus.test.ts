// @vitest-environment happy-dom

import { afterEach, expect, test } from 'vitest';

import { shouldFocusComposer } from './type-to-focus';

function press(key: string, target?: Element, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, ...init });
  Object.defineProperty(event, 'target', { value: target ?? document.body });
  return event;
}

function mount(html: string): Element {
  document.body.innerHTML = html;
  return document.body.firstElementChild as Element;
}

afterEach(() => {
  document.body.innerHTML = '';
});

test('claims a printable key, shifted or not', () => {
  expect(shouldFocusComposer(press('a'))).toBe(true);
  expect(shouldFocusComposer(press('A', undefined, { shiftKey: true }))).toBe(true);
  expect(shouldFocusComposer(press('é'))).toBe(true);
});

test('leaves named keys, shortcuts and the space bar alone', () => {
  expect(shouldFocusComposer(press('Enter'))).toBe(false);
  expect(shouldFocusComposer(press('Escape'))).toBe(false);
  expect(shouldFocusComposer(press('ArrowDown'))).toBe(false);
  expect(shouldFocusComposer(press(' '))).toBe(false);
  expect(shouldFocusComposer(press('k', undefined, { ctrlKey: true }))).toBe(false);
  expect(shouldFocusComposer(press('n', undefined, { altKey: true }))).toBe(false);
});

test('leaves a press inside an editable target alone', () => {
  const input = mount('<input />');
  expect(shouldFocusComposer(press('a', input))).toBe(false);

  const editable = mount('<div contenteditable="true"></div>');
  expect(shouldFocusComposer(press('a', editable))).toBe(false);
});

test('yields to an open dialog, menu or listbox', () => {
  mount('<div role="dialog"></div>');
  expect(shouldFocusComposer(press('a'))).toBe(false);

  mount('<div role="menu"></div>');
  expect(shouldFocusComposer(press('a'))).toBe(false);

  mount('<div class="dialog-content"></div>');
  expect(shouldFocusComposer(press('a'))).toBe(false);
});
