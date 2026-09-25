// @vitest-environment happy-dom

import { afterEach, describe, expect, test, vi } from 'vitest';
import { undo } from 'prosemirror-history';
import { Fragment, Slice } from 'prosemirror-model';
import { NodeSelection, Selection, TextSelection } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';

import { preferences } from '#lib/settings/preferences.svelte.js';
import { activeQuery } from '../autocomplete';
import { ComposerEditor, type ComposerEditorOptions } from './composer-editor';
import { composerSchema } from './schema';
import { serializeComposer, serializePlain } from './serialize';

let dispose: (() => void) | undefined;
const defaultUserAgent = navigator.userAgent;

afterEach(() => {
  preferences.enterForNewline = false;
  preferences.richTextComposer = true;
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
    onLinkRequest: () => {},
    onSpoilerRequest: () => {},
    onSourceToggle: () => {},
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

function beforeInput(element: HTMLElement, inputType: string, cancelable = true): Event {
  const event = new Event('beforeinput', { bubbles: true, cancelable });
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
  editor.setText('one\n\ntwo');
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

  test('keeps underline and spoiler marks for an edit', () => {
    const editor = open();

    editor.setHtml('<p><u>loud</u> and <span data-mx-spoiler>quiet</span></p>');
    const doc = editor.doc();

    expect(doc && serializeComposer(doc).formatted).toBe(
      '<u>loud</u> and <span data-mx-spoiler="">quiet</span>'
    );
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

function caretAfterMention(editorView: EditorView): void {
  const { doc } = editorView.state;
  editorView.dispatch(
    editorView.state.tr.setSelection(TextSelection.create(doc, doc.content.size - 2))
  );
}

function hasMention(editor: ComposerEditor): boolean {
  let found = false;
  editor.doc()?.descendants((node) => {
    if (node.type === composerSchema.nodes.mention) found = true;
  });
  return found;
}

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

  test('deletes a mention instead of selecting it', () => {
    setUserAgent(androidUserAgent);
    const editor = open();
    editor.setText('hi ');
    editor.insert(composerSchema.nodes.mention.create({ userId: '@me:example.org', name: 'Me' }));
    const editorView = view(editor);
    caretAfterMention(editorView);

    const event = beforeInput(surface(), 'deleteContentBackward');

    expect(event.defaultPrevented).toBe(true);
    expect(hasMention(editor)).toBe(false);
    expect(editorView.state.selection).toBeInstanceOf(TextSelection);
  });

  test('deletes a mention the IME selects after an uncancelable backspace', () => {
    setUserAgent(androidUserAgent);
    const editor = open();
    editor.setText('hi ');
    editor.insert(composerSchema.nodes.mention.create({ userId: '@me:example.org', name: 'Me' }));
    const editorView = view(editor);
    caretAfterMention(editorView);
    const { from } = editorView.state.selection;

    beforeInput(surface(), 'deleteContentBackward', false);
    editorView.dispatch(
      editorView.state.tr.setSelection(NodeSelection.create(editorView.state.doc, from - 1))
    );

    expect(hasMention(editor)).toBe(false);
    expect(editorView.state.selection).toBeInstanceOf(TextSelection);
  });

  test('keeps the caret after a mention the IME selects once the space before it is gone', () => {
    setUserAgent(androidUserAgent);
    const editor = open();
    editor.setText('hi ');
    editor.insert(composerSchema.nodes.mention.create({ userId: '@me:example.org', name: 'Me' }));
    const editorView = view(editor);
    const { from } = editorView.state.selection;

    beforeInput(surface(), 'deleteContentBackward', false);
    editorView.dispatch(editorView.state.tr.delete(from - 1, from));
    editorView.dispatch(
      editorView.state.tr.setSelection(NodeSelection.create(editorView.state.doc, from - 2))
    );

    expect(hasMention(editor)).toBe(true);
    expect(editorView.state.selection).toBeInstanceOf(TextSelection);
    expect(editorView.state.selection.head).toBe(from - 1);
  });

  test('only swallows the first selection of a mention after a backspace', () => {
    setUserAgent(androidUserAgent);
    const editor = open();
    editor.setText('hi ');
    editor.insert(composerSchema.nodes.mention.create({ userId: '@me:example.org', name: 'Me' }));
    const editorView = view(editor);
    const { from } = editorView.state.selection;

    beforeInput(surface(), 'deleteContentBackward', false);
    editorView.dispatch(editorView.state.tr.delete(from - 1, from));
    const selectMention = () => {
      editorView.dispatch(
        editorView.state.tr.setSelection(NodeSelection.create(editorView.state.doc, from - 2))
      );
    };
    selectMention();
    selectMention();

    expect(hasMention(editor)).toBe(true);
    expect(editorView.state.selection).toBeInstanceOf(NodeSelection);
  });

  test('still selects a tapped mention', () => {
    setUserAgent(androidUserAgent);
    const editor = open();
    editor.setText('hi ');
    editor.insert(composerSchema.nodes.mention.create({ userId: '@me:example.org', name: 'Me' }));
    const editorView = view(editor);
    caretAfterMention(editorView);
    const { from } = editorView.state.selection;

    beforeInput(surface(), 'deleteContentBackward', false);
    editorView.dispatch(
      editorView.state.tr
        .setSelection(NodeSelection.create(editorView.state.doc, from - 1))
        .setMeta('pointer', true)
    );

    expect(hasMention(editor)).toBe(true);
    expect(editorView.state.selection).toBeInstanceOf(NodeSelection);
  });

  test('removes an empty code block before the IME can mutate its DOM', () => {
    setUserAgent(androidUserAgent);
    const editor = open();
    editor.setHtml('<pre></pre>');
    view(editor).dispatch(
      view(editor).state.tr.setSelection(TextSelection.create(view(editor).state.doc, 1))
    );

    const event = beforeInput(surface(), 'deleteContentBackward');

    expect(event.defaultPrevented).toBe(true);
    expect(editor.doc()?.firstChild?.type.name).toBe('paragraph');
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

test('iOS-style beforeinput removes an empty code block', () => {
  setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)');
  const editor = open();
  editor.setHtml('<pre></pre>');
  view(editor).dispatch(
    view(editor).state.tr.setSelection(TextSelection.create(view(editor).state.doc, 1))
  );

  const event = beforeInput(surface(), 'deleteContentBackward');

  expect(event.defaultPrevented).toBe(true);
  expect(editor.doc()?.firstChild?.type.name).toBe('paragraph');
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
    onLinkRequest: () => {},
    onSpoilerRequest: () => {},
    onSourceToggle: () => {},
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

function press(
  editor: ComposerEditor,
  key: string,
  modifiers: boolean | { shift?: boolean; mod?: boolean } = false
): void {
  const { shift = false, mod = false } =
    typeof modifiers === 'boolean' ? { shift: modifiers } : modifiers;
  const event = new KeyboardEvent('keydown', {
    key,
    shiftKey: shift,
    ctrlKey: mod,
    bubbles: true,
    cancelable: true,
  });
  view(editor).someProp('handleKeyDown', (handler) => handler(view(editor), event));
}

function pressSurface(key: string, modifiers: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key,
    bubbles: true,
    cancelable: true,
    ...modifiers,
  });
  surface().dispatchEvent(event);
  return event;
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
    const code = view(editor).state.doc.firstChild;
    if (!code) throw new Error('code block not found');
    view(editor).dispatch(
      view(editor).state.tr.setSelection(
        TextSelection.create(view(editor).state.doc, code.nodeSize - 1)
      )
    );
    press(editor, 'Enter');

    const doc = editor.doc();
    expect(doc?.firstChild?.type.name).toBe('code_block');
    expect(doc?.firstChild?.textContent).toBe('a\n');
  });

  test('enter on the blank last line of a code block exits and takes the newline with it', () => {
    const editor = open();
    editor.setHtml('<pre>a\n</pre>');
    const block = view(editor).state.doc.firstChild;
    if (!block) throw new Error('code block not found');
    view(editor).dispatch(
      view(editor).state.tr.setSelection(
        TextSelection.create(view(editor).state.doc, block.nodeSize - 1)
      )
    );
    press(editor, 'Enter');

    expect(editor.doc()?.firstChild?.textContent).toBe('a');
    expect(view(editor).state.selection.$from.parent.type.name).toBe('paragraph');
    expect(surface().querySelector('pre code')?.textContent).toBe('a');
    expect(surface().querySelectorAll('pre br.ProseMirror-trailingBreak')).toHaveLength(0);
    expect(surface().querySelectorAll('p br.ProseMirror-trailingBreak')).toHaveLength(1);
  });

  test('enter in a freshly opened code block writes a newline instead of leaving it', () => {
    const editor = open();
    editor.setHtml('<pre></pre>');
    view(editor).dispatch(
      view(editor).state.tr.setSelection(TextSelection.create(view(editor).state.doc, 1))
    );
    press(editor, 'Enter');

    expect(view(editor).state.selection.$from.parent.type.name).toBe('code_block');
    expect(editor.doc()?.firstChild?.textContent).toBe('\n');
  });

  test('backspace on an empty code block removes the block', () => {
    const editor = open();
    editor.setHtml('<pre></pre>');
    view(editor).dispatch(
      view(editor).state.tr.setSelection(TextSelection.create(view(editor).state.doc, 1))
    );

    const event = pressSurface('Backspace');

    expect(event.defaultPrevented).toBe(true);
    expect(editor.doc()?.firstChild?.type.name).toBe('paragraph');
    expect(surface().querySelector('pre')).toBeNull();
  });

  test('enter after a fence opens the block it names', () => {
    const editor = open();
    editor.setText('```rust');
    view(editor).dispatch(
      view(editor).state.tr.setSelection(Selection.atEnd(view(editor).state.doc))
    );
    const event = pressSurface('Enter');

    const code = editor.doc()?.firstChild;
    expect(event.defaultPrevented).toBe(true);
    expect(code?.type.name).toBe('code_block');
    expect(code?.attrs.language).toBe('rust');
    expect(code?.textContent).toBe('');
    expect(surface().querySelector('pre')?.getAttribute('data-language')).toBe('rust');
    expect(surface().querySelector('pre code')?.textContent).toBe('');
  });

  test('enter after a fence ignores its trailing whitespace', () => {
    const editor = open();
    editor.setText('```golang  ');
    view(editor).dispatch(
      view(editor).state.tr.setSelection(Selection.atEnd(view(editor).state.doc))
    );
    press(editor, 'Enter');

    expect(editor.doc()?.firstChild?.attrs.language).toBe('golang');
  });

  test('enter after a bare fence opens an empty block', () => {
    const editor = open();
    editor.setText('```');
    view(editor).dispatch(
      view(editor).state.tr.setSelection(Selection.atEnd(view(editor).state.doc))
    );
    press(editor, 'Enter');

    expect(editor.doc()?.firstChild?.type.name).toBe('code_block');
    expect(editor.doc()?.firstChild?.attrs.language).toBe('');
  });

  test('shift+arrowdown exits a code block from its final line', () => {
    const editor = open();
    editor.setHtml('<pre>a</pre>');
    const block = view(editor).state.doc.firstChild;
    if (!block) throw new Error('code block not found');
    view(editor).dispatch(
      view(editor).state.tr.setSelection(
        TextSelection.create(view(editor).state.doc, block.nodeSize - 1)
      )
    );
    press(editor, 'ArrowDown', true);

    const selection = view(editor).state.selection;
    expect(selection.empty).toBe(true);
    expect(selection.$from.parent.type.name).toBe('paragraph');
  });

  test('shift+arrowup exits a code block from its first line', () => {
    const editor = open();
    editor.setHtml('<pre>a</pre>');
    view(editor).dispatch(
      view(editor).state.tr.setSelection(Selection.atStart(view(editor).state.doc))
    );
    press(editor, 'ArrowUp', true);

    const doc = editor.doc();
    expect(doc?.firstChild?.type.name).toBe('paragraph');
    expect(doc?.child(1).type.name).toBe('code_block');
  });

  test('shift+arrow keys escape from any position on the first or last code line', () => {
    const editor = open();
    editor.setHtml('<pre>first\nlast</pre>');
    const editorView = view(editor);

    editorView.dispatch(
      editorView.state.tr.setSelection(TextSelection.create(editorView.state.doc, 3))
    );
    press(editor, 'ArrowUp', true);
    expect(editor.doc()?.firstChild?.type.name).toBe('paragraph');

    const code = editor.doc()?.child(1);
    if (!code) throw new Error('code block not found');
    editorView.dispatch(
      editorView.state.tr.setSelection(
        TextSelection.create(editorView.state.doc, code.nodeSize + 1)
      )
    );
    press(editor, 'ArrowDown', true);
    expect(editor.doc()?.lastChild?.type.name).toBe('paragraph');
  });

  test('mod+enter sends from inside a code block', () => {
    const submit = vi.fn();
    const editor = openWith({ onSubmit: submit });
    editor.setHtml('<pre>a</pre>');
    press(editor, 'Enter', { mod: true });

    expect(submit).toHaveBeenCalledTimes(1);
  });

  test('shift+arrow keys traverse into adjacent blocks without adding paragraphs', () => {
    const editor = open();
    editor.setHtml('<p>before</p><pre>code</pre><p>after</p>');
    const editorView = view(editor);
    let codePosition = -1;
    editorView.state.doc.descendants((node, position) => {
      if (node.type === composerSchema.nodes.code_block) codePosition = position;
    });
    if (codePosition < 0) throw new Error('code block not found');

    editorView.dispatch(
      editorView.state.tr.setSelection(TextSelection.create(editorView.state.doc, codePosition + 1))
    );
    press(editor, 'ArrowUp', true);
    expect(editor.doc()?.childCount).toBe(3);
    expect(editorView.state.selection.$from.parent.type.name).toBe('paragraph');

    const code = editor.doc()?.child(1);
    if (!code) throw new Error('code block not found');
    editorView.dispatch(
      editorView.state.tr.setSelection(
        TextSelection.create(editorView.state.doc, codePosition + code.nodeSize - 1)
      )
    );
    press(editor, 'ArrowDown', true);
    expect(editor.doc()?.childCount).toBe(3);
    expect(editorView.state.selection.$from.parent.type.name).toBe('paragraph');
  });

  test('shift+arrow keys put a caret back inside an adjacent code block', () => {
    const editor = open();
    editor.setHtml('<p>before</p><pre>alpha</pre><p>after</p>');
    const editorView = view(editor);
    const paragraph = editorView.state.doc.child(0);

    editorView.dispatch(
      editorView.state.tr.setSelection(
        TextSelection.create(editorView.state.doc, paragraph.nodeSize - 1)
      )
    );
    press(editor, 'ArrowDown', true);

    let selection = editorView.state.selection;
    expect(selection.empty).toBe(true);
    expect(selection.$from.parent.type.name).toBe('code_block');
    expect(selection.$from.parentOffset).toBe(0);

    editorView.dispatch(editorView.state.tr.setSelection(Selection.atEnd(editorView.state.doc)));
    press(editor, 'ArrowUp', true);

    selection = editorView.state.selection;
    expect(selection.empty).toBe(true);
    expect(selection.$from.parent.type.name).toBe('code_block');
    expect(selection.$from.parentOffset).toBe('alpha'.length);
  });

  test('escaping a nested code block lands the caret in the paragraph it made', () => {
    const editor = open();
    editor.setHtml('<p>before</p><blockquote><pre>one</pre></blockquote>');
    const editorView = view(editor);
    let codePosition = -1;
    editorView.state.doc.descendants((node, position) => {
      if (node.type === composerSchema.nodes.code_block) codePosition = position;
    });
    editorView.dispatch(
      editorView.state.tr.setSelection(TextSelection.create(editorView.state.doc, codePosition + 1))
    );
    press(editor, 'ArrowUp', true);

    const selection = editorView.state.selection;
    expect(selection.$from.parent.type.name).toBe('paragraph');
    expect(selection.$from.parent.content.size).toBe(0);
    expect(selection.$from.node(-1).type.name).toBe('blockquote');
  });

  test('escape leaves the selection alone when no autocomplete is open', () => {
    const editor = open();
    editor.setHtml('<pre>a</pre>');
    const before = view(editor).state.selection.from;
    press(editor, 'Escape');

    expect(view(editor).state.selection).toBeInstanceOf(TextSelection);
    expect(view(editor).state.selection.from).toBe(before);
  });

  test('a block that cannot be typed after gains a trailing paragraph', () => {
    const editor = open();
    editor.setHtml('<hr>');

    expect(editor.doc()?.childCount).toBe(2);
    expect(editor.doc()?.lastChild?.type.name).toBe('paragraph');
  });

  test('a code block gains none, since enter leaves it on its own', () => {
    const editor = open();
    editor.setHtml('<pre>a</pre>');

    expect(editor.doc()?.childCount).toBe(1);
  });

  test('a document already ending in a paragraph gains nothing', () => {
    const editor = open();
    editor.setText('hi');

    expect(editor.doc()?.childCount).toBe(1);
  });

  test('enter on an empty line inside a quote lifts out of it', () => {
    preferences.enterForNewline = true;
    const editor = open();
    editor.setHtml('<blockquote><p>a</p><p></p></blockquote>');
    const quote = view(editor).state.doc.firstChild;
    if (!quote) throw new Error('blockquote not found');
    view(editor).dispatch(
      view(editor).state.tr.setSelection(
        TextSelection.create(view(editor).state.doc, quote.nodeSize - 2)
      )
    );
    press(editor, 'Enter');

    const doc = editor.doc();
    expect(doc?.child(0).type.name).toBe('blockquote');
    expect(doc?.child(0).childCount).toBe(1);
    expect(view(editor).state.selection.$from.depth).toBe(1);
  });

  test('a selection-only transaction does not report a document change', () => {
    const changes: boolean[] = [];
    const editor = openWith({ onChange: (change) => changes.push(change.docChanged) });
    editor.setText('hello');
    changes.length = 0;

    view(editor).dispatch(
      view(editor).state.tr.setSelection(Selection.atStart(view(editor).state.doc))
    );
    expect(changes).toEqual([false]);
  });
});

test('the enter key hint follows the preference', () => {
  const editor = open();
  expect(surface().getAttribute('enterkeyhint')).toBe('send');

  preferences.enterForNewline = true;
  editor.syncKeyHint();

  expect(surface().getAttribute('enterkeyhint')).toBe('enter');
});

describe('rebuilding the plugin stack', () => {
  test('clearHistory leaves the caret where the writer had it', () => {
    const editor = open();
    editor.setText('hello there');
    const before = view(editor).state.selection.from;

    editor.clearHistory();

    expect(view(editor).state.selection.from).toBe(before);
  });

  test('reconfigure leaves the caret where the writer had it', () => {
    const editor = open();
    editor.setText('hello there');
    const before = view(editor).state.selection.from;

    editor.reconfigure();

    expect(view(editor).state.selection.from).toBe(before);
  });

  test('a rebuild reports the state the caller renders from', () => {
    const changes: boolean[] = [];
    const queries: (string | null)[] = [];
    const editor = openWith({
      onChange: (change) => changes.push(change.empty),
      onQuery: (next) => queries.push(next?.query ?? null),
    });
    editor.setText('hi @amp');
    changes.length = 0;
    queries.length = 0;

    editor.reconfigure();

    expect(changes).toEqual([false]);
    expect(queries).toEqual(['amp']);
  });
});

describe('link', () => {
  test('format asks the caller for a link rather than mutating the document', () => {
    const onLinkRequest = vi.fn();
    const editor = openWith({ onLinkRequest });
    editor.setText('docs');

    editor.format('link');
    const doc = editor.doc();

    expect(onLinkRequest).toHaveBeenCalledOnce();
    expect(doc && serializeComposer(doc).formatted).toBeNull();
  });

  test('mod+shift+k asks for a link and mod+k is left to the global shortcut', () => {
    const onLinkRequest = vi.fn();
    const editor = openWith({ onLinkRequest });
    editor.setText('docs');

    press(editor, 'k', { mod: true });
    expect(onLinkRequest).not.toHaveBeenCalled();

    press(editor, 'k', { mod: true, shift: true });
    expect(onLinkRequest).toHaveBeenCalledOnce();
  });

  test('applyLink marks the current selection', () => {
    const editor = open();
    editor.setText('docs');
    view(editor).dispatch(
      view(editor).state.tr.setSelection(Selection.atStart(view(editor).state.doc))
    );
    view(editor).dispatch(
      view(editor).state.tr.setSelection(
        TextSelection.create(view(editor).state.doc, 1, view(editor).state.doc.content.size - 1)
      )
    );

    editor.applyLink('https://example.org');

    const doc = editor.doc();
    expect(doc && serializeComposer(doc).formatted).toBe('<a href="https://example.org">docs</a>');
  });

  test('applyLink inserts the href as text when there is no selection', () => {
    const editor = open();

    editor.applyLink('https://example.org');

    const doc = editor.doc();
    expect(doc && serializeComposer(doc).formatted).toBe(
      '<a href="https://example.org">https://example.org</a>'
    );
  });
});

describe('pasting', () => {
  function pasteRich(editor: ComposerEditor, text: string): void {
    const editorView = view(editor);
    const slice = editorView.someProp('clipboardTextParser', (parse) =>
      parse(text, editorView.state.selection.$from, false, editorView)
    );
    if (!slice) throw new Error('no clipboard parser');
    editorView.dispatch(editorView.state.tr.replaceSelection(slice));
  }

  test('markdown pasted as text arrives with its marks', () => {
    preferences.richTextComposer = true;
    const editor = open();
    pasteRich(editor, 'a **bold** word');

    const marks: string[] = [];
    editor.doc()?.descendants((node) => {
      if (node.text === 'bold') marks.push(...node.marks.map((mark) => mark.type.name));
    });
    expect(editor.doc()?.textContent).toBe('a bold word');
    expect(marks).toEqual(['strong']);
  });

  test('a plain paste keeps the characters it was given', () => {
    const editor = open();
    view(editor).pasteText('a **bold** word');

    expect(editor.doc()?.textContent).toBe('a **bold** word');
  });

  test('markdown is left alone with the rich composer off', () => {
    preferences.richTextComposer = false;
    const editor = open();
    pasteRich(editor, 'a **bold** word');

    expect(editor.doc()?.textContent).toBe('a **bold** word');
    preferences.richTextComposer = true;
  });

  test('an address pasted over a selection links it instead of replacing it', () => {
    const editor = open();
    editor.setText('the docs');
    const editorView = view(editor);
    editorView.dispatch(editorView.state.tr.setSelection(Selection.atStart(editorView.state.doc)));
    editorView.dispatch(
      editorView.state.tr.setSelection(
        TextSelection.create(editorView.state.doc, 1, editorView.state.doc.content.size - 1)
      )
    );
    editorView.pasteText('https://example.org');

    expect(editor.doc()?.textContent).toBe('the docs');
    const hrefs: string[] = [];
    editor.doc()?.descendants((node) => {
      for (const mark of node.marks) {
        if (mark.type.name === 'link') hrefs.push(mark.attrs.href as string);
      }
    });
    expect(hrefs).toEqual(['https://example.org']);
  });
});

describe('the placeholder', () => {
  test('is reported for an untouched composer and after it is cleared', () => {
    const seen: boolean[] = [];
    const editor = openWith({ onChange: (change) => seen.push(change.placeholder) });
    editor.setText('hi');
    expect(seen.at(-1)).toBe(false);

    editor.clear();
    expect(seen.at(-1)).toBe(true);
  });

  test('is withheld from an empty block that is not a paragraph', () => {
    const seen: boolean[] = [];
    const editor = openWith({ onChange: (change) => seen.push(change.placeholder) });
    editor.setHtml('<pre></pre>');

    expect(editor.isEmpty()).toBe(true);
    expect(seen.at(-1)).toBe(false);
  });
});

describe('the markdown source toggle', () => {
  test('swaps the document for its source and back', () => {
    preferences.richTextComposer = true;
    const editor = open();
    editor.setHtml('<p>a <strong>bold</strong> word</p>');

    expect(editor.toggleSource()).toBe(true);
    expect(editor.doc()?.textContent).toBe('a **bold** word');

    expect(editor.toggleSource()).toBe(false);
    const marks: string[] = [];
    editor.doc()?.descendants((node) => {
      if (node.text === 'bold') marks.push(...node.marks.map((mark) => mark.type.name));
    });
    expect(marks).toEqual(['strong']);
  });
});

describe('the markdown source toggle round trip', () => {
  test('a code block keeps its line breaks through source and back', () => {
    preferences.richTextComposer = true;
    const editor = open();
    editor.setHtml('<pre><code>const a = 1;\nconst b = 2;</code></pre>');

    editor.toggleSource();
    const source = editor.doc();
    if (!source) throw new Error('no doc');
    expect(serializePlain(source).body).toBe('```\nconst a = 1;\nconst b = 2;\n```');

    editor.toggleSource();
    const block = editor.doc()?.firstChild;
    expect(block?.type.name).toBe('code_block');
    expect(block?.textContent).toBe('const a = 1;\nconst b = 2;');
  });

  test('the keyboard shortcut reports the mode it left the editor in', () => {
    const modes: boolean[] = [];
    const editor = openWith({ onSourceToggle: (source) => modes.push(source) });
    editor.setText('hi');
    press(editor, 'm', { mod: true, shift: true });
    press(editor, 'm', { mod: true, shift: true });

    expect(modes).toEqual([true, false]);
  });
});

describe('spoilers', () => {
  test('applying one from the toolbar asks for a reason first', () => {
    const onSpoilerRequest = vi.fn();
    const editor = openWith({ onSpoilerRequest });
    editor.setText('secret');
    editor.format('spoiler');

    expect(onSpoilerRequest).toHaveBeenCalledTimes(1);

    const editorView = view(editor);
    editorView.dispatch(
      editorView.state.tr.setSelection(
        TextSelection.create(editorView.state.doc, 1, editorView.state.doc.content.size - 1)
      )
    );
    editor.applySpoiler('ending');

    const doc = editor.doc();
    if (!doc) throw new Error('no doc');
    expect(serializeComposer(doc).formatted).toBe('<span data-mx-spoiler="ending">secret</span>');
  });

  test('an empty selection carries the reason into what is typed next', () => {
    const editor = openWith({ onSpoilerRequest: () => {} });
    editor.applySpoiler('ending');
    const editorView = view(editor);
    editorView.dispatch(editorView.state.tr.insertText('later'));

    const doc = editor.doc();
    if (!doc) throw new Error('no doc');
    expect(serializeComposer(doc).formatted).toBe('<span data-mx-spoiler="ending">later</span>');
  });
});

function type(editor: ComposerEditor, text: string): void {
  const editorView = view(editor);
  for (const char of text) {
    const { from, to } = editorView.state.selection;
    const handled = editorView.someProp('handleTextInput', (handler) =>
      handler(editorView, from, to, char, () => editorView.state.tr)
    );
    if (!handled) editorView.dispatch(editorView.state.tr.insertText(char, from, to));
  }
}

describe('block markup on a soft line', () => {
  test('enter after a fence typed below a soft break opens a block instead of sending', () => {
    let sent = 0;
    const editor = openWith({ onSubmit: () => (sent += 1) });
    type(editor, 'look:');
    press(editor, 'Enter', true);
    type(editor, '```rust');
    press(editor, 'Enter');

    expect(sent).toBe(0);
    const doc = editor.doc();
    expect(doc?.childCount).toBe(2);
    expect(doc?.firstChild?.textContent).toBe('look:');
    expect(doc?.child(1).type.name).toBe('code_block');
    expect(doc?.child(1).attrs.language).toBe('rust');
  });

  test('a bullet marker typed below a soft break opens a list', () => {
    const editor = open();
    type(editor, 'list:');
    press(editor, 'Enter', true);
    type(editor, '- one');

    const doc = editor.doc();
    expect(doc && serializeComposer(doc).formatted).toBe(
      '<p>list:</p><ul><li><p>one</p></li></ul>'
    );
  });

  test('a heading marker below a soft break becomes a heading', () => {
    const editor = open();
    type(editor, 'intro');
    press(editor, 'Enter', true);
    type(editor, '## title');

    const doc = editor.doc();
    expect(doc && serializeComposer(doc).formatted).toBe('<p>intro</p><h2>title</h2>');
  });

  test('a marker after a mention rather than a soft break is left alone', () => {
    const editor = open();
    editor.insert(composerSchema.nodes.mention.create({ userId: '@a:example.org', name: 'A' }));
    type(editor, '- x');

    expect(editor.doc()?.childCount).toBe(1);
    expect(editor.doc()?.firstChild?.type.name).toBe('paragraph');
  });
});

describe('enter inside a list', () => {
  test('starts a new item rather than sending', () => {
    let sent = 0;
    const editor = openWith({ onSubmit: () => (sent += 1) });
    type(editor, '- one');
    press(editor, 'Enter');
    type(editor, 'two');

    expect(sent).toBe(0);
    const doc = editor.doc();
    expect(doc && serializeComposer(doc).formatted).toBe(
      '<ul><li><p>one</p></li><li><p>two</p></li></ul>'
    );
  });

  test('on an empty item leaves the list, and the next enter sends', () => {
    let sent = 0;
    const editor = openWith({ onSubmit: () => (sent += 1) });
    type(editor, '- one');
    press(editor, 'Enter');
    press(editor, 'Enter');
    expect(sent).toBe(0);
    expect(editor.doc()?.lastChild?.type.name).toBe('paragraph');

    press(editor, 'Enter');
    expect(sent).toBe(1);
  });
});

describe('markdown source mode', () => {
  test('leaves typed markdown as text', () => {
    const editor = open();
    editor.setText('hi');
    editor.toggleSource();
    type(editor, ' **bold** and `code`');

    expect(editor.doc()?.firstChild?.childCount).toBe(1);
    expect(editor.doc()?.textContent).toBe('hi **bold** and `code`');

    editor.toggleSource();
    const doc = editor.doc();
    expect(doc && serializeComposer(doc).formatted).toBe(
      'hi <strong>bold</strong> and <code>code</code>'
    );
  });

  test('a fence followed by enter stays text', () => {
    let sent = 0;
    const editor = openWith({ onSubmit: () => (sent += 1) });
    editor.setText('x');
    editor.toggleSource();
    press(editor, 'Enter', true);
    type(editor, '```');
    press(editor, 'Enter');

    expect(sent).toBe(1);
  });

  test('keeps its undo history across the toggle', () => {
    const editor = open();
    editor.setText('one');
    editor.toggleSource();
    const editorView = view(editor);
    undo(editorView.state, editorView.dispatch, editorView);

    expect(editor.doc()?.textContent).toBe('');
  });
});

describe('a typed space after a committed pill', () => {
  test('is swallowed, since the commit already wrote one', () => {
    const editor = open();
    editor.insert(composerSchema.nodes.mention.create({ userId: '@a:example.org', name: 'A' }));
    type(editor, ' x');

    const doc = editor.doc();
    expect(doc && serializeComposer(doc).body).toBe('A x');
  });

  test('a second deliberate space still goes in', () => {
    const editor = open();
    editor.insert(composerSchema.nodes.mention.create({ userId: '@a:example.org', name: 'A' }));
    type(editor, '  x');

    const doc = editor.doc();
    expect(doc && serializeComposer(doc).body).toBe('A  x');
  });
});

test('a soft break on its own is not content', () => {
  const editor = open();
  press(editor, 'Enter', true);

  expect(editor.isEmpty()).toBe(true);
});

describe('soft breaks leave a heading and a quote', () => {
  test('shift+enter at the end of a heading starts a paragraph', () => {
    const editor = open();
    type(editor, '# Title');
    press(editor, 'Enter', true);
    type(editor, 'body');

    const doc = editor.doc();
    expect(doc && serializeComposer(doc).formatted).toBe('<h1>Title</h1><p>body</p>');
  });

  test('a second shift+enter on the blank last line of a quote leaves it', () => {
    const editor = open();
    type(editor, '> quote');
    press(editor, 'Enter', true);
    press(editor, 'Enter', true);
    type(editor, 'out');

    const doc = editor.doc();
    expect(doc && serializeComposer(doc).formatted).toBe(
      '<blockquote><p>quote</p></blockquote><p>out</p>'
    );
  });
});

describe('markers on a soft line inside a container', () => {
  test('a quote marker continues the quote instead of nesting one', () => {
    const editor = open();
    type(editor, '> a');
    press(editor, 'Enter', true);
    type(editor, '> b');

    const doc = editor.doc();
    expect(doc && serializeComposer(doc).formatted).toBe(
      '<blockquote><p>a</p><p>b</p></blockquote>'
    );
  });

  test('a bullet marker makes a sibling item instead of a sublist', () => {
    const editor = open();
    type(editor, '- a');
    press(editor, 'Enter', true);
    type(editor, '- b');

    const doc = editor.doc();
    expect(doc && serializeComposer(doc).formatted).toBe(
      '<ul><li><p>a</p></li><li><p>b</p></li></ul>'
    );
  });

  test('a number marker makes a sibling item too', () => {
    const editor = open();
    type(editor, '1. a');
    press(editor, 'Enter', true);
    type(editor, '2. b');

    const doc = editor.doc();
    expect(doc && serializeComposer(doc).formatted).toBe(
      '<ol><li><p>a</p></li><li><p>b</p></li></ol>'
    );
  });
});

test('backspace removes a mention rather than selecting it', () => {
  const editor = open();
  editor.setText('hi ');
  editor.insert(composerSchema.nodes.mention.create({ userId: '@me:example.org', name: 'Me' }));

  caretAfterMention(view(editor));
  press(editor, 'Backspace');

  expect(hasMention(editor)).toBe(false);
  expect(view(editor).state.selection).toBeInstanceOf(TextSelection);
});

describe('backspace undoes a block rule even when the block ends the document', () => {
  test.each(['- ', '# ', '> '])('%j comes back as text', (marker) => {
    const editor = open();
    type(editor, marker);
    press(editor, 'Backspace');

    expect(editor.doc()?.firstChild?.type.name).toBe('paragraph');
    expect(editor.doc()?.textContent).toBe(marker);
  });

  test('a marker typed below a soft break comes back with the break', () => {
    const editor = open();
    type(editor, 'x');
    press(editor, 'Enter', true);
    type(editor, '- ');
    press(editor, 'Backspace');

    expect(editor.doc()?.childCount).toBe(1);
    expect(editor.doc()?.firstChild?.child(1).type.name).toBe('hard_break');
    expect(editor.doc()?.textContent).toBe('x- ');
  });
});

describe('arrow keys at the edge of the document', () => {
  function caretAt(editor: ComposerEditor, where: 'start' | 'end' | number): void {
    const editorView = view(editor);
    const { doc } = editorView.state;
    const selection =
      where === 'start'
        ? Selection.atStart(doc)
        : where === 'end'
          ? Selection.atEnd(doc)
          : TextSelection.create(doc, where);
    editorView.dispatch(editorView.state.tr.setSelection(selection));
  }

  function onLineEdge(editor: ComposerEditor, value: boolean): void {
    vi.spyOn(view(editor), 'endOfTextblock').mockReturnValue(value);
  }

  test('left at the very start is claimed so the webview cannot move focus away', () => {
    const editor = open();
    editor.setText('ab');
    caretAt(editor, 'start');

    expect(pressSurface('ArrowLeft').defaultPrevented).toBe(true);
    expect(pressSurface('ArrowRight').defaultPrevented).toBe(false);
  });

  test('right at the very end is claimed', () => {
    const editor = open();
    editor.setText('ab');
    caretAt(editor, 'end');

    expect(pressSurface('ArrowRight').defaultPrevented).toBe(true);
    expect(pressSurface('ArrowLeft').defaultPrevented).toBe(false);
  });

  test('left and right in the middle of the text are left to the browser', () => {
    const editor = open();
    editor.setText('abc');
    caretAt(editor, 2);

    expect(pressSurface('ArrowLeft').defaultPrevented).toBe(false);
    expect(pressSurface('ArrowRight').defaultPrevented).toBe(false);
  });

  test('the start of a later block is not the start of the document', () => {
    const editor = open();
    editor.setText('one\n\ntwo');
    const editorView = view(editor);
    caretAt(editor, editorView.state.doc.child(0).nodeSize + 1);

    expect(pressSurface('ArrowLeft').defaultPrevented).toBe(false);
  });

  test('a selection away from the edges is left to the browser', () => {
    const editor = open();
    editor.setText('abc');
    const editorView = view(editor);
    editorView.dispatch(
      editorView.state.tr.setSelection(TextSelection.create(editorView.state.doc, 2, 3))
    );

    expect(pressSurface('ArrowLeft').defaultPrevented).toBe(false);
    expect(pressSurface('ArrowRight').defaultPrevented).toBe(false);
  });

  test('left on a selection that touches the start collapses it there', () => {
    const editor = open();
    editor.setText('ab');
    const editorView = view(editor);
    editorView.dispatch(
      editorView.state.tr.setSelection(TextSelection.create(editorView.state.doc, 1, 2))
    );

    expect(pressSurface('ArrowRight').defaultPrevented).toBe(false);
    expect(pressSurface('ArrowLeft').defaultPrevented).toBe(true);
    expect(editorView.state.selection.empty).toBe(true);
    expect(editorView.state.selection.from).toBe(1);
  });

  test('shift-selecting is claimed only once the head reaches the edge', () => {
    const editor = open();
    editor.setText('ab');
    const editorView = view(editor);
    const { doc } = editorView.state;

    editorView.dispatch(editorView.state.tr.setSelection(TextSelection.create(doc, 1, 2)));
    expect(pressSurface('ArrowLeft', { shiftKey: true }).defaultPrevented).toBe(false);

    editorView.dispatch(editorView.state.tr.setSelection(TextSelection.create(doc, 2, 1)));
    expect(pressSurface('ArrowLeft', { shiftKey: true }).defaultPrevented).toBe(true);
    expect(editorView.state.selection.anchor).toBe(2);
  });

  test('modified arrows are claimed at the edge too', () => {
    const editor = open();
    editor.setText('ab');
    caretAt(editor, 'start');

    expect(pressSurface('ArrowLeft', { ctrlKey: true }).defaultPrevented).toBe(true);
    expect(pressSurface('ArrowLeft', { altKey: true }).defaultPrevented).toBe(true);
    expect(pressSurface('ArrowLeft', { metaKey: true }).defaultPrevented).toBe(true);

    caretAt(editor, 'end');
    expect(pressSurface('ArrowRight', { ctrlKey: true }).defaultPrevented).toBe(true);
  });

  test('the edge is claimed while an IME composition is open', () => {
    const editor = open();
    editor.setText('ab');
    caretAt(editor, 'end');
    surface().dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));

    expect(view(editor).composing).toBe(true);
    expect(pressSurface('ArrowRight').defaultPrevented).toBe(true);
  });

  test('a node selected at the edge is claimed and collapses beside it', () => {
    const editor = open();
    editor.setText('');
    editor.insert(composerSchema.nodes.mention.create({ userId: '@a:x', name: 'A' }));
    const editorView = view(editor);
    const { doc } = editorView.state;

    editorView.dispatch(editorView.state.tr.setSelection(NodeSelection.create(doc, 1)));
    expect(pressSurface('ArrowLeft').defaultPrevented).toBe(true);
    expect(editorView.state.selection).toBeInstanceOf(TextSelection);
    expect(editorView.state.selection.from).toBe(1);
  });

  test('the start of a code block that opens the document counts as the start', () => {
    const editor = open();
    editor.setHtml('<pre>code</pre><p>after</p>');
    caretAt(editor, 1);

    expect(pressSurface('ArrowLeft').defaultPrevented).toBe(true);
  });

  test('up on the first line of the first block is claimed', () => {
    const editor = open();
    editor.setText('one');
    caretAt(editor, 'end');
    onLineEdge(editor, true);

    expect(pressSurface('ArrowUp').defaultPrevented).toBe(true);
  });

  test('up on a wrapped line below the first is left to the browser', () => {
    const editor = open();
    editor.setText('one');
    caretAt(editor, 'end');
    onLineEdge(editor, false);

    expect(pressSurface('ArrowUp').defaultPrevented).toBe(false);
  });

  test('down on the last line of the last block is claimed', () => {
    const editor = open();
    editor.setText('one\n\ntwo');
    caretAt(editor, 'end');
    onLineEdge(editor, true);

    expect(pressSurface('ArrowDown').defaultPrevented).toBe(true);
  });

  test('up and down inside an earlier or later block are left to the browser', () => {
    const editor = open();
    editor.setText('one\n\ntwo');
    onLineEdge(editor, true);

    caretAt(editor, 'start');
    expect(pressSurface('ArrowDown').defaultPrevented).toBe(false);

    caretAt(editor, 'end');
    expect(pressSurface('ArrowUp').defaultPrevented).toBe(false);
  });

  test('the suggestion panel still gets the arrows first', () => {
    const keys: string[] = [];
    const editor = openWith({
      onNavigate: (key) => {
        keys.push(key);
        return true;
      },
    });
    editor.setText('@no');
    caretAt(editor, 'end');
    onLineEdge(editor, false);

    expect(pressSurface('ArrowUp').defaultPrevented).toBe(true);
    expect(pressSurface('ArrowDown').defaultPrevented).toBe(true);
    expect(keys).toEqual(['ArrowUp', 'ArrowDown']);
  });

  test('an empty composer claims all four directions', () => {
    const editor = open();
    onLineEdge(editor, true);

    for (const key of ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']) {
      expect(pressSurface(key).defaultPrevented, key).toBe(true);
    }
  });
});

describe('the editor api the composer component drives', () => {
  test('text spells atoms and breaks back out', () => {
    const editor = open();
    editor.setText('hi');
    editor.insert(composerSchema.nodes.mention.create({ userId: '@a:x', name: 'A' }));
    press(editor, 'Enter', true);
    editor.insert(composerSchema.text('x'));

    expect(editor.text()).toBe('hiA \nx ');
  });

  test('focus and blur move the document focus onto and off the surface', () => {
    const editor = open();
    editor.focus();
    expect(document.activeElement).toBe(surface());
    editor.blur();
    expect(document.activeElement).not.toBe(surface());
    expect(editor.editable()).toBe(surface());
  });

  test('syncLabel and syncEditable re-read the options onto the surface', () => {
    let label = 'first';
    let editable = true;
    const editor = openWith({ label: () => label, editable: () => editable });
    expect(surface().getAttribute('aria-label')).toBe('first');
    expect(surface().getAttribute('contenteditable')).toBe('true');

    label = 'second';
    editor.syncLabel();
    expect(surface().getAttribute('aria-label')).toBe('second');

    editable = false;
    editor.syncEditable();
    expect(surface().getAttribute('contenteditable')).toBe('false');
  });

  test('the enter key hint follows the newline preference', () => {
    const editor = open();
    expect(surface().getAttribute('enterkeyhint')).toBe('send');
    preferences.enterForNewline = true;
    editor.syncKeyHint();
    expect(surface().getAttribute('enterkeyhint')).toBe('enter');
  });

  test('copying formatted text puts markdown on the clipboard', () => {
    const editor = open();
    editor.setHtml('<p>a <strong>bold</strong> <a href="https://x.y">link</a></p>');
    const editorView = view(editor);
    editorView.dispatch(
      editorView.state.tr.setSelection(
        TextSelection.create(editorView.state.doc, 1, editorView.state.doc.content.size - 1)
      )
    );
    const { text } = editorView.serializeForClipboard(editorView.state.selection.content());

    expect(text).toBe('a **bold** [link](https://x.y)');
  });

  test('copying plain text leaves it plain', () => {
    const editor = open();
    editor.setText('just words');
    const editorView = view(editor);
    editorView.dispatch(
      editorView.state.tr.setSelection(
        TextSelection.create(editorView.state.doc, 1, editorView.state.doc.content.size - 1)
      )
    );
    expect(editorView.serializeForClipboard(editorView.state.selection.content()).text).toBe(
      'just words'
    );
  });

  test('dropped files are handed to the caller instead of being inserted', () => {
    const onFiles = vi.fn();
    const editor = openWith({ onFiles });
    const file = new File(['x'], 'x.png', { type: 'image/png' });
    const event = { dataTransfer: { files: [file], items: [] } } as unknown as DragEvent;
    const handled = view(editor).someProp('handleDrop', (handler) =>
      handler(view(editor), event, Slice.empty, false)
    );

    expect(handled).toBe(true);
    expect(onFiles).toHaveBeenCalledWith([file]);
  });

  test('a drop without files is left to ProseMirror', () => {
    const editor = open();
    const event = { dataTransfer: { files: [], items: [] } } as unknown as DragEvent;
    const handled = view(editor).someProp('handleDrop', (handler) =>
      handler(view(editor), event, Slice.empty, false)
    );

    expect(handled).toBeFalsy();
  });

  test('a pasted blob image is fetched back into a file for the caller', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(new Response(new Blob(['x'], { type: 'image/png' })))
    );
    const onFiles = vi.fn();
    const editor = openWith({ onFiles });
    const slice = new Slice(
      Fragment.from(composerSchema.nodes.image.create({ src: 'blob:tauri://localhost/abc' })),
      0,
      0
    );
    const event = { clipboardData: { files: [], items: [] } } as unknown as ClipboardEvent;
    const handled = view(editor).someProp('handlePaste', (handler) =>
      handler(view(editor), event, slice)
    );

    expect(handled).toBe(true);
    await vi.waitFor(() => {
      expect(onFiles).toHaveBeenCalledOnce();
    });
    expect((onFiles.mock.calls[0] as [File[]])[0][0]?.name).toBe('pasted-image.png');
    expect(editor.isEmpty()).toBe(true);
    vi.unstubAllGlobals();
  });

  test('a paste that is only prose is left to ProseMirror', () => {
    const editor = open();
    const slice = new Slice(Fragment.from(composerSchema.text('plain')), 0, 0);
    const event = { clipboardData: { files: [], items: [] } } as unknown as ClipboardEvent;
    const handled = view(editor).someProp('handlePaste', (handler) =>
      handler(view(editor), event, slice)
    );

    expect(handled).toBeFalsy();
  });

  test('a rebuild for a preference change keeps the document and the caret', () => {
    const editor = open();
    editor.setText('keep');
    preferences.richTextComposer = false;
    editor.reconfigure();

    expect(editor.doc()?.textContent).toBe('keep');
    expect(view(editor).state.selection.from).toBe(5);
    type(editor, ' **x**');
    expect(editor.doc()?.textContent).toBe('keep **x**');
  });
});

describe('Enter for a newline in the plain composer', () => {
  function typeLines(editor: ComposerEditor, lines: string[]): void {
    for (const [index, line] of lines.entries()) {
      if (index > 0) press(editor, 'Enter');
      type(editor, line);
    }
  }

  test('breaks the line instead of starting a paragraph', () => {
    preferences.richTextComposer = false;
    preferences.enterForNewline = true;
    const editor = open();
    typeLines(editor, ['a', 'b']);

    const doc = editor.doc();
    if (!doc) throw new Error('no doc');
    expect(serializePlain(doc).body).toBe('a\nb');
  });

  test('keeps a typed fence as markdown, with its lines single-spaced', () => {
    preferences.richTextComposer = false;
    preferences.enterForNewline = true;
    const editor = open();
    typeLines(editor, ['```', 'a', 'b', '```']);

    const doc = editor.doc();
    if (!doc) throw new Error('no doc');
    const message = serializePlain(doc);
    expect(message.body).toBe('```\na\nb\n```');
    expect(message.formatted).toBe('<pre><code>a\nb</code></pre>');
  });
});

describe('formatting in the plain composer writes markdown', () => {
  function plainEditor(text: string): ComposerEditor {
    preferences.richTextComposer = false;
    const editor = open();
    type(editor, text);
    return editor;
  }

  function select(editor: ComposerEditor, from: number, to: number): void {
    const editorView = view(editor);
    editorView.dispatch(
      editorView.state.tr.setSelection(TextSelection.create(editorView.state.doc, from, to))
    );
  }

  function body(editor: ComposerEditor): string {
    const doc = editor.doc();
    if (!doc) throw new Error('no doc');
    return serializePlain(doc).body;
  }

  test('bold wraps the selection, and a second press unwraps it', () => {
    const editor = plainEditor('say hi');
    select(editor, 5, 7);
    editor.format('strong');
    expect(body(editor)).toBe('say **hi**');

    editor.format('strong');
    expect(body(editor)).toBe('say hi');
  });

  test('italic over bold text adds its own marker instead of eating one of bold', () => {
    const editor = plainEditor('**hi**');
    select(editor, 3, 5);
    editor.format('em');
    expect(body(editor)).toBe('***hi***');
  });

  test('a list prefixes every selected line', () => {
    const editor = plainEditor('one');
    press(editor, 'Enter', true);
    type(editor, 'two');
    select(editor, 1, view(editor).state.doc.content.size - 1);
    editor.format('bullet_list');
    expect(body(editor)).toBe('- one\n- two');
  });

  test('a code block fences the selection on its own lines', () => {
    const editor = plainEditor('x = 1');
    select(editor, 1, 6);
    editor.format('code_block');
    expect(body(editor)).toBe('```\nx = 1\n```');
  });

  test('a link is written as markdown', () => {
    const editor = plainEditor('docs');
    select(editor, 1, 5);
    editor.applyLink('https://example.org');
    expect(body(editor)).toBe('[docs](https://example.org)');
  });
});

describe('code indentation in the composer', () => {
  function paste(text: string, html?: string): void {
    const data = new DataTransfer();
    data.setData('text/plain', text);
    if (html) data.setData('text/html', html);
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: data });
    surface().dispatchEvent(event);
  }

  test('a paste from an editor keeps its indentation and its line spacing in plain mode', () => {
    preferences.richTextComposer = false;
    const editor = open();
    type(editor, '```');
    press(editor, 'Enter', true);
    paste(
      'fn main() {\n    let x = 1;\n}',
      '<div><div><span>fn main() {</span></div><div><span>    let x = 1;</span></div><div><span>}</span></div></div>'
    );
    press(editor, 'Enter', true);
    type(editor, '```');

    const doc = editor.doc();
    if (!doc) throw new Error('no doc');
    expect(serializePlain(doc).body).toBe('```\nfn main() {\n    let x = 1;\n}\n```');
  });

  test('Tab indents inside a code block', () => {
    preferences.richTextComposer = true;
    preferences.enterForNewline = true;
    const editor = open();
    type(editor, '```');
    press(editor, 'Enter');
    press(editor, 'Tab');
    type(editor, 'x');

    expect(editor.doc()?.firstChild?.textContent).toBe('    x');
  });

  test('Tab indents inside an open fence in plain mode, and nowhere else', () => {
    preferences.richTextComposer = false;
    const editor = open();
    press(editor, 'Tab');
    type(editor, '```');
    press(editor, 'Enter', true);
    press(editor, 'Tab');
    type(editor, 'x');

    const doc = editor.doc();
    if (!doc) throw new Error('no doc');
    expect(serializePlain(doc).body).toBe('```\n    x');
  });
});
