// @vitest-environment happy-dom

import { afterEach, describe, expect, test, vi } from 'vitest';
import { undo } from 'prosemirror-history';
import { Selection } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';

import { preferences } from '#lib/settings/preferences.svelte.js';
import { activeQuery } from '../autocomplete';
import { ComposerEditor, type ComposerEditorOptions } from './composer-editor';
import { composerSchema } from './schema';
import { serializeComposer } from './serialize';

let dispose: (() => void) | undefined;
const defaultUserAgent = navigator.userAgent;

afterEach(() => {
  preferences.enterForNewline = false;
  dispose?.();
  dispose = undefined;
  document.body.replaceChildren();
  vi.useRealTimers();
  Object.defineProperty(navigator, 'userAgent', { configurable: true, value: defaultUserAgent });
});

function openWith(overrides: Partial<ComposerEditorOptions> = {}): ComposerEditor {
  const host = document.createElement('div');
  document.body.append(host);
  const editor = new ComposerEditor({
    media: { cached: () => undefined, load: () => Promise.resolve('blob:x'), hold: () => () => {} },
    emotes: () => [],
    label: () => 'Send a message',
    listboxId: 'suggestions',
    activeOptionId: () => null,
    editable: () => true,
    onSubmit: () => {},
    onChange: () => {},
    onQuery: () => {},
    onNavigate: () => false,
    onFiles: () => {},
    ...overrides,
  });
  dispose = editor.mount(host);
  return editor;
}

function open(): ComposerEditor {
  return openWith();
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

function beforeInput(element: HTMLElement, inputType: string): Event {
  const event = new Event('beforeinput', { bubbles: true, cancelable: true });
  Object.assign(event, { inputType });
  element.dispatchEvent(event);
  return event;
}

function setUserAgent(userAgent: string): void {
  Object.defineProperty(navigator, 'userAgent', { configurable: true, value: userAgent });
}

test('committing an emote keeps the text that came before it', () => {
  const editor = open();
  editor.setText('hey :vv');

  const found = query(editor);
  editor.replaceQuery(
    { sigil: ':', query: 'vv', start: found.start, end: found.end },
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

describe('attachVia', () => {
  const roomMention = () =>
    composerSchema.nodes.mention.create({ userId: '!abc:example.org', name: '#Sable' });

  test('patches the servers into a room mention already inserted', () => {
    const editor = open();
    editor.insert(roomMention());

    editor.attachVia('!abc:example.org', ['sable.moe']);
    const doc = editor.doc();

    expect(doc && serializeComposer(doc).formatted).toBe(
      '<a href="https://matrix.to/#/!abc:example.org?via=sable.moe">#Sable</a> '
    );
  });

  test('leaves the text the user typed while it resolved alone', () => {
    const editor = open();
    editor.insert(roomMention());
    editor.insert(composerSchema.text('later'));

    editor.attachVia('!abc:example.org', ['sable.moe']);
    const doc = editor.doc();

    expect(doc && serializeComposer(doc).body).toBe('#Sable later');
  });

  test('does not become its own undo step', () => {
    const editor = open();
    editor.insert(roomMention());

    editor.attachVia('!abc:example.org', ['sable.moe']);
    const editorView = view(editor);
    undo(editorView.state, editorView.dispatch);

    expect(editor.isEmpty()).toBe(true);
  });
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

describe('setHtml', () => {
  test('keeps the marks of a formatted message', () => {
    const editor = open();

    editor.setHtml('<p>look <strong>here</strong></p>');
    const doc = editor.doc();

    expect(doc && serializeComposer(doc).body).toBe('look **here**');
  });

  test('keeps a mention as a mention, not as a link', () => {
    const editor = open();

    editor.setHtml('<p>ask <a href="https://matrix.to/#/@one:example.org">Member One</a></p>');
    const doc = editor.doc();

    expect(doc && serializeComposer(doc)).toEqual({
      body: 'ask Member One',
      formatted: 'ask <a href="https://matrix.to/#/@one:example.org">Member One</a>',
      mentions: { userIds: ['@one:example.org'], room: false },
    });
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

describe('Android enter', () => {
  const androidUserAgent = 'Mozilla/5.0 (Linux; Android 14; Pixel 8)';

  test.each(['insertParagraph', 'insertLineBreak'])('submits on %s', (inputType) => {
    setUserAgent(androidUserAgent);
    const submit = vi.fn();
    const editor = openWith({ onSubmit: submit });
    editor.setText('hi');

    const event = beforeInput(surface(), inputType);

    expect(submit).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
    expect(editor.doc()?.textContent).toBe('hi');
  });

  test('leaves the paragraph to ProseMirror off Android', () => {
    setUserAgent(defaultUserAgent);
    const submit = vi.fn();
    openWith({ onSubmit: submit });

    const event = beforeInput(surface(), 'insertParagraph');

    expect(submit).not.toHaveBeenCalled();
    expect(event.defaultPrevented).toBe(false);
  });
});

test('the active option is written straight onto the editor node', () => {
  const host = document.createElement('div');
  document.body.append(host);
  let activeId: string | null = null;
  const editor = new ComposerEditor({
    media: { cached: () => undefined, load: () => Promise.resolve('blob:x'), hold: () => () => {} },
    emotes: () => [],
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

function press(editor: ComposerEditor, key: string, shift = false): void {
  const event = new KeyboardEvent('keydown', {
    key,
    shiftKey: shift,
    bubbles: true,
    cancelable: true,
  });
  view(editor).someProp('handleKeyDown', (handler) => handler(view(editor), event));
}

describe('block editing', () => {
  test('shift+enter inserts a soft break instead of a second paragraph', () => {
    const editor = open();
    editor.setText('one');
    press(editor, 'Enter', true);
    editor.insert(composerSchema.text('two'));

    const doc = editor.doc();
    expect(doc?.childCount).toBe(1);
    expect(doc?.firstChild?.child(1).type.name).toBe('hard_break');
  });

  test('a soft break keeps the marks, so the message still sends formatted', () => {
    const editor = open();
    editor.setHtml('<p><strong>one</strong></p>');
    view(editor).dispatch(
      view(editor).state.tr.setSelection(Selection.atEnd(view(editor).state.doc))
    );
    press(editor, 'Enter', true);

    const doc = editor.doc();
    if (!doc) throw new Error('no doc');
    expect(doc.childCount).toBe(1);
    expect(serializeComposer(doc).formatted).toContain('<strong>');
  });

  test('enter inside a code block adds a newline rather than a second block', () => {
    const editor = open();
    editor.setHtml('<pre>a</pre>');
    view(editor).dispatch(
      view(editor).state.tr.setSelection(Selection.atEnd(view(editor).state.doc))
    );
    press(editor, 'Enter');

    const doc = editor.doc();
    expect(doc?.childCount).toBe(1);
    expect(doc?.firstChild?.type.name).toBe('code_block');
    expect(doc?.firstChild?.textContent).toBe('a\n');
  });

  test('enter on an empty line inside a quote lifts out of it', () => {
    preferences.enterForNewline = true;
    const editor = open();
    editor.setHtml('<blockquote><p>a</p><p></p></blockquote>');
    view(editor).dispatch(
      view(editor).state.tr.setSelection(Selection.atEnd(view(editor).state.doc))
    );
    press(editor, 'Enter');

    const doc = editor.doc();
    expect(doc?.childCount).toBe(2);
    expect(doc?.child(1).type.name).toBe('paragraph');
  });

  test('a selection-only transaction does not report a document change', () => {
    const changes: boolean[] = [];
    const editor = openWith({ onChange: (_empty, _marks, docChanged) => changes.push(docChanged) });
    editor.setText('hello');
    changes.length = 0;

    view(editor).dispatch(
      view(editor).state.tr.setSelection(Selection.atStart(view(editor).state.doc))
    );
    expect(changes).toEqual([false]);
  });
});
