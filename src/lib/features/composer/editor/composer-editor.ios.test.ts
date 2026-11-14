// @vitest-environment happy-dom

import { afterEach, expect, test, vi } from 'vitest';

vi.hoisted(() => {
  Object.defineProperty(navigator, 'userAgent', {
    configurable: true,
    value:
      'Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1',
  });
  Object.defineProperty(navigator, 'vendor', { configurable: true, value: 'Apple Computer, Inc.' });
});

import { preferences } from '#lib/settings/preferences.svelte.js';
import { ComposerEditor } from './composer-editor';

let dispose: (() => void) | undefined;

afterEach(() => {
  preferences.enterForNewline = 'send';
  vi.unstubAllGlobals();
  dispose?.();
  dispose = undefined;
  document.body.replaceChildren();
  vi.useRealTimers();
});

function open(onSubmit: () => void): ComposerEditor {
  const host = document.createElement('div');
  document.body.append(host);
  const editor = new ComposerEditor({
    media: { cached: () => undefined, load: () => Promise.resolve('blob:x'), hold: () => () => {} },
    emotes: () => [],
    label: () => 'Send a message',
    listboxId: 'suggestions',
    activeOptionId: () => null,
    editable: () => true,
    onSubmit,
    onChange: () => {},
    onQuery: () => {},
    onNavigate: () => false,
    onFiles: () => {},
    onLinkRequest: () => {},
    onSpoilerRequest: () => {},
    onSourceToggle: () => {},
  });
  dispose = editor.mount(host);
  return editor;
}

function pressEnter(shiftKey: boolean, heldShift = shiftKey, code = ''): void {
  const surface = document.querySelector<HTMLElement>('[contenteditable]');
  if (!surface) throw new Error('editor surface not found');
  if (heldShift)
    surface.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', bubbles: true }));
  const event = new KeyboardEvent('keydown', { key: 'Enter', code, shiftKey, bubbles: true });
  Object.defineProperty(event, 'keyCode', { value: 13 });
  surface.dispatchEvent(event);
  vi.advanceTimersByTime(250);
}

test.each([
  ['sends', false, false, 1, 'paragraph("hi")'],
  ['breaks the line', true, false, 0, 'paragraph("hi", hard_break)'],
  ['breaks the line', false, true, 0, 'paragraph("hi", hard_break)'],
  ['sends', true, true, 1, 'paragraph("hi")'],
])(
  'on iOS the Enter key %s (shift %s, enter for newline %s)',
  (_, shiftKey, enterForNewline, submits, doc) => {
    vi.useFakeTimers();
    preferences.enterForNewline = enterForNewline ? 'newline' : 'send';
    const submit = vi.fn();
    const editor = open(submit);
    editor.setText('hi');

    pressEnter(shiftKey);

    expect(submit).toHaveBeenCalledTimes(submits);
    expect(editor.doc()?.firstChild?.toString()).toBe(doc);
  }
);

test('on iOS the auto-capitalise shift is not a Shift press', () => {
  vi.useFakeTimers();
  preferences.enterForNewline = 'newline';
  const submit = vi.fn();
  const editor = open(submit);
  editor.setText('hi');

  pressEnter(true, false);

  expect(submit).not.toHaveBeenCalled();
  expect(editor.doc()?.firstChild?.toString()).toBe('paragraph("hi", hard_break)');
});

test('on iOS a dropped Shift keyup does not make later Enters sends', () => {
  vi.useFakeTimers();
  preferences.enterForNewline = 'newline';
  const submit = vi.fn();
  const editor = open(submit);
  editor.setText('hi');
  const surface = document.querySelector<HTMLElement>('[contenteditable]');
  if (!surface) throw new Error('editor surface not found');

  surface.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', bubbles: true }));
  surface.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
  pressEnter(true, false);

  expect(submit).not.toHaveBeenCalled();
  expect(editor.doc()?.firstChild?.toString()).toBe('paragraph("hi", hard_break)');
});

test.each([
  ['a physical keyboard sends', 'Enter', 1, 'paragraph("hi")'],
  ['the on-screen keyboard breaks the line', '', 0, 'paragraph("hi", hard_break)'],
])('on a touch device the adaptive Enter key from %s', (_, code, submits, doc) => {
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', (query: string) =>
    Object.assign(new EventTarget(), { matches: query === '(pointer: coarse)', media: query })
  );
  vi.stubGlobal(
    'visualViewport',
    Object.assign(new EventTarget(), { height: window.innerHeight, offsetTop: 0 })
  );
  preferences.enterForNewline = 'adaptive';
  const submit = vi.fn();
  const editor = open(submit);
  editor.setText('hi');

  pressEnter(false, false, code);

  expect(submit).toHaveBeenCalledTimes(submits);
  expect(editor.doc()?.firstChild?.toString()).toBe(doc);
});
