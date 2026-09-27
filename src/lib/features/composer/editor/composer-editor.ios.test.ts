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
  preferences.enterForNewline = false;
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

function pressEnter(shiftKey: boolean): void {
  const surface = document.querySelector<HTMLElement>('[contenteditable]');
  if (!surface) throw new Error('editor surface not found');
  const event = new KeyboardEvent('keydown', { key: 'Enter', shiftKey, bubbles: true });
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
    preferences.enterForNewline = enterForNewline;
    const submit = vi.fn();
    const editor = open(submit);
    editor.setText('hi');

    pressEnter(shiftKey);

    expect(submit).toHaveBeenCalledTimes(submits);
    expect(editor.doc()?.firstChild?.toString()).toBe(doc);
  }
);
