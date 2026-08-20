// @vitest-environment happy-dom

import { afterEach, describe, expect, test, vi } from 'vitest';
import { undo } from 'prosemirror-history';
import type { EditorView } from 'prosemirror-view';

import { activeQuery } from '../autocomplete';
import { ComposerEditor } from './composer-editor';
import { composerSchema } from './schema';
import { serializeComposer } from './serialize';

let dispose: (() => void) | undefined;
const defaultUserAgent = navigator.userAgent;

afterEach(() => {
  dispose?.();
  dispose = undefined;
  document.body.replaceChildren();
  vi.useRealTimers();
  Object.defineProperty(navigator, 'userAgent', { configurable: true, value: defaultUserAgent });
});

function open(): ComposerEditor {
  const host = document.createElement('div');
  document.body.append(host);
  const editor = new ComposerEditor({
    media: { cached: () => undefined, load: () => Promise.resolve('blob:x') },
    label: () => 'Send a message',
    listboxId: 'suggestions',
    activeOptionId: () => null,
    editable: () => true,
    onSubmit: () => {},
    onChange: () => {},
    onQuery: () => {},
    onNavigate: () => false,
    onFiles: () => {},
  });
  dispose = editor.mount(host);
  return editor;
}

function query(editor: ComposerEditor): { start: number; end: number; sigil: string } {
  const doc = editor.doc();
  if (!doc) throw new Error('no doc');
  const text = doc.textBetween(1, doc.content.size - 1, ' ', ' ');
  const found = activeQuery(text, text.length);
  if (!found) throw new Error(`no query in ${text}`);
  return { ...found, start: found.start + 1, end: text.length + 1 };
}

function view(editor: ComposerEditor): EditorView {
  return (editor as unknown as { view: EditorView }).view;
}

function surface(): HTMLElement {
  const element = document.querySelector<HTMLElement>('[contenteditable]');
  if (!element) throw new Error('editor surface not found');
  return element;
}

function beforeInput(element: HTMLElement, inputType: string): void {
  const event = new Event('beforeinput', { bubbles: true, cancelable: true });
  Object.assign(event, { inputType });
  element.dispatchEvent(event);
}

function setUserAgent(userAgent: string): void {
  Object.defineProperty(navigator, 'userAgent', { configurable: true, value: userAgent });
}

test('committing an emote keeps the text that came before it', () => {
  const editor = open();
  editor.setText('hey :v');

  const found = query(editor);
  editor.replaceQuery(
    { sigil: ':', query: 'v', start: found.start, end: found.end },
    composerSchema.nodes.emoticon.create({ url: 'mxc://example.org/vv', shortcode: 'vv' })
  );

  const doc = editor.doc();
  if (!doc) throw new Error('no doc');
  expect(serializeComposer(doc).body).toBe('hey :vv:');
});

test('committing a mention keeps the text that came before it', () => {
  const editor = open();
  editor.setText('hi @me');

  const found = query(editor);
  editor.replaceQuery(
    { sigil: '@', query: 'me', start: found.start, end: found.end },
    composerSchema.nodes.mention.create({ userId: '@me:example.org', name: 'Me' })
  );

  const doc = editor.doc();
  if (!doc) throw new Error('no doc');
  expect(serializeComposer(doc).body).toBe('hi Me');
});

test('a mention-only document is not empty', () => {
  const editor = open();
  editor.insert(composerSchema.nodes.mention.create({ userId: '@me:example.org', name: 'Me' }));

  expect(editor.isEmpty()).toBe(false);
});

test('clear empties the document and setText refills it', () => {
  const editor = open();
  editor.setText('one\ntwo');
  expect(editor.doc()?.childCount).toBe(2);

  editor.clear();
  expect(editor.isEmpty()).toBe(true);
});

describe('document replacement', () => {
  test.each(['one', 'one\ntwo'])('places the selection at the end of %j', (text) => {
    const editor = open();
    editor.setText(text);
    const editorView = view(editor);

    expect(editorView.state.selection.from).toBe(editorView.state.doc.content.size - 1);
  });
});

describe('history reset', () => {
  test('prevents Undo from restoring sent content', () => {
    const editor = open();
    editor.insert(composerSchema.text('sent'));
    editor.clear();
    editor.clearHistory();
    const editorView = view(editor);

    undo(editorView.state, editorView.dispatch, editorView);

    expect(editor.isEmpty()).toBe(true);
  });
});

describe('Android backspace fallback', () => {
  const androidUserAgent = 'Mozilla/5.0 (Linux; Android 14; Pixel 8)';

  test('updates state without blurring when the IME leaves the DOM untouched', () => {
    setUserAgent(androidUserAgent);
    vi.useFakeTimers();
    const editor = open();
    editor.setText('hi');
    const editorSurface = surface();
    editorSurface.focus();

    beforeInput(editorSurface, 'deleteContentBackward');
    vi.advanceTimersByTime(50);

    expect(editor.doc()?.textContent).toBe('h');
    expect(document.activeElement).toBe(editorSurface);
  });

  test('does not delete twice when the IME updates editor state first', () => {
    setUserAgent(androidUserAgent);
    vi.useFakeTimers();
    const editor = open();
    editor.setText('hi');
    const editorView = view(editor);

    beforeInput(surface(), 'deleteContentBackward');
    const { from } = editorView.state.selection;
    editorView.dispatch(editorView.state.tr.delete(from - 1, from));
    vi.advanceTimersByTime(50);

    expect(editor.doc()?.textContent).toBe('h');
  });

  test.each([
    ['Android non-delete input', androidUserAgent, 'insertText'],
    ['non-Android backward delete', defaultUserAgent, 'deleteContentBackward'],
  ])('leaves %s to ProseMirror', (_name, userAgent, inputType) => {
    setUserAgent(userAgent);
    vi.useFakeTimers();
    const editor = open();
    editor.setText('hi');

    beforeInput(surface(), inputType);
    vi.advanceTimersByTime(50);

    expect(editor.doc()?.textContent).toBe('hi');
  });
});

test('the active option is written straight onto the editor node', () => {
  const host = document.createElement('div');
  document.body.append(host);
  let activeId: string | null = null;
  const editor = new ComposerEditor({
    media: { cached: () => undefined, load: () => Promise.resolve('blob:x') },
    label: () => 'Send a message',
    listboxId: 'suggestions',
    activeOptionId: () => activeId,
    editable: () => true,
    onSubmit: () => {},
    onChange: () => {},
    onQuery: () => {},
    onNavigate: () => false,
    onFiles: vi.fn(),
  });
  dispose = editor.mount(host);
  const surface = host.querySelector('[contenteditable]');

  activeId = 'suggestions-2';
  editor.syncActiveOption();
  expect(surface?.getAttribute('aria-activedescendant')).toBe('suggestions-2');
  expect(surface?.getAttribute('aria-expanded')).toBe('true');

  activeId = null;
  editor.syncActiveOption();
  expect(surface?.getAttribute('aria-activedescendant')).toBeNull();
  expect(surface?.getAttribute('aria-expanded')).toBe('false');
});
