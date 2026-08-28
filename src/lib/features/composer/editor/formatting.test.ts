// @vitest-environment happy-dom

import { inputRules } from 'prosemirror-inputrules';
import { EditorState, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { afterEach, expect, test } from 'vitest';

import { activeMarks, formatCommands, formattingInputRules } from './formatting';
import { composerSchema } from './schema';

let view: EditorView | undefined;

afterEach(() => {
  view?.destroy();
  view = undefined;
  document.body.replaceChildren();
});

function type(text: string): void {
  for (const char of text) {
    const editor = view;
    if (!editor) throw new Error('no editor');
    const { from, to } = editor.state.selection;
    const handled = editor.someProp('handleTextInput', (handler) =>
      handler(editor, from, to, char, () => editor.state.tr)
    );
    if (!handled) editor.dispatch(editor.state.tr.insertText(char, from, to));
  }
}

function open(): EditorView {
  const host = document.createElement('div');
  document.body.append(host);
  view = new EditorView(host, {
    state: EditorState.create({
      schema: composerSchema,
      plugins: [inputRules({ rules: formattingInputRules })],
    }),
  });
  return view;
}

function marksOn(word: string): string[] {
  const editor = view;
  if (!editor) throw new Error('no editor');
  const names: string[] = [];
  editor.state.doc.descendants((node) => {
    if (node.isText && node.text === word) names.push(...node.marks.map((mark) => mark.type.name));
  });
  return names;
}

test('emphasis mid-sentence keeps the character before the marker', () => {
  open();
  type('I really *love* this');

  expect(view?.state.doc.textContent).toBe('I really love this');
  expect(marksOn('love')).toEqual(['em']);
});

test('bold does not lose its leading space either', () => {
  open();
  type('say **hi** now');

  expect(view?.state.doc.textContent).toBe('say hi now');
  expect(marksOn('hi')).toEqual(['strong']);
});

test('strike and code round trip mid-sentence', () => {
  open();
  type('a ~~b~~ and `c` end');

  expect(view?.state.doc.textContent).toBe('a b and c end');
  expect(marksOn('b')).toEqual(['strike']);
  expect(marksOn('c')).toEqual(['code']);
});

test('a heading marker at the line start becomes a heading', () => {
  open();
  type('## Title');

  expect(view?.state.doc.firstChild?.type.name).toBe('heading');
  expect(view?.state.doc.firstChild?.attrs.level).toBe(2);
  expect(view?.state.doc.textContent).toBe('Title');
});

test('a bullet marker opens a list', () => {
  open();
  type('- item');

  expect(view?.state.doc.firstChild?.type.name).toBe('bullet_list');
  expect(view?.state.doc.textContent).toBe('item');
});

test('an underscore inside a word does not become emphasis', () => {
  open();
  type('call snake_case_name now');

  expect(view?.state.doc.textContent).toBe('call snake_case_name now');
  expect(marksOn('call snake_case_name now')).toEqual([]);
});

test('an underscore around a word still becomes emphasis', () => {
  open();
  type('say _hi_ now');

  expect(view?.state.doc.textContent).toBe('say hi now');
  expect(marksOn('hi')).toEqual(['em']);
});

test('a bold marker typed inside a code span stays literal', () => {
  const editor = open();
  const code = composerSchema.text('ab', [composerSchema.marks.code.create()]);
  const tr = editor.state.tr.replaceWith(
    0,
    editor.state.doc.content.size,
    composerSchema.node('paragraph', null, code)
  );
  editor.dispatch(tr.setSelection(TextSelection.create(tr.doc, 2)));
  type('**b**');

  expect(view?.state.doc.textContent).toBe('a**b**b');
  expect(marksOn('a**b**b')).toEqual(['code']);
});

test('a mark rule keeps the marks the range already carried', () => {
  open();
  type('**a ~~b~~ c**');

  expect(view?.state.doc.textContent).toBe('a b c');
  expect(marksOn('b').sort()).toEqual(['strike', 'strong']);
});

function selectAll(): void {
  const editor = view;
  if (!editor) throw new Error('no editor');
  const end = editor.state.doc.content.size;
  editor.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 1, end - 1)));
}

test('the underline command marks the selection', () => {
  const editor = open();
  type('hello');
  selectAll();
  formatCommands.underline(editor.state, editor.dispatch.bind(editor), editor);

  expect(marksOn('hello')).toEqual(['underline']);
  expect(activeMarks(editor.state)).toContain('underline');
});

test('the spoiler command marks the selection', () => {
  const editor = open();
  type('secret');
  selectAll();
  formatCommands.spoiler(editor.state, editor.dispatch.bind(editor), editor);

  expect(marksOn('secret')).toEqual(['spoiler']);
  expect(activeMarks(editor.state)).toContain('spoiler');
});

test('a heading command sets the level and toggles back to a paragraph', () => {
  const editor = open();
  type('Title');

  formatCommands.heading1(editor.state, editor.dispatch.bind(editor), editor);
  expect(editor.state.doc.firstChild?.type.name).toBe('heading');
  expect(editor.state.doc.firstChild?.attrs.level).toBe(1);
  expect(activeMarks(editor.state)).toContain('heading1');

  formatCommands.heading1(editor.state, editor.dispatch.bind(editor), editor);
  expect(editor.state.doc.firstChild?.type.name).toBe('paragraph');
});

test('the code_block command toggles the block type', () => {
  const editor = open();
  type('const x = 1');

  formatCommands.code_block(editor.state, editor.dispatch.bind(editor), editor);
  expect(editor.state.doc.firstChild?.type.name).toBe('code_block');
  expect(activeMarks(editor.state)).toContain('code_block');

  formatCommands.code_block(editor.state, editor.dispatch.bind(editor), editor);
  expect(editor.state.doc.firstChild?.type.name).toBe('paragraph');
});

test('the ordered_list command wraps the paragraph in a numbered list', () => {
  const editor = open();
  type('one');

  formatCommands.ordered_list(editor.state, editor.dispatch.bind(editor), editor);
  expect(editor.state.doc.firstChild?.type.name).toBe('ordered_list');
  expect(activeMarks(editor.state)).toContain('ordered_list');
});

function run(action: 'bullet_list' | 'ordered_list' | 'blockquote'): void {
  const editor = view;
  if (!editor) throw new Error('no editor');
  formatCommands[action](editor.state, editor.dispatch.bind(editor), editor);
}

function caretInto(word: string): void {
  const editor = view;
  if (!editor) throw new Error('no editor');
  let position = -1;
  editor.state.doc.descendants((node, pos) => {
    if (node.isText && node.text === word) position = pos + 1;
  });
  if (position < 0) throw new Error(`no text node reading ${word}`);
  editor.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, position)));
}

test('the blockquote command lifts out of a quote instead of nesting another', () => {
  const editor = open();
  type('quoted');

  run('blockquote');
  expect(editor.state.doc.toString()).toBe('doc(blockquote(paragraph("quoted")))');

  run('blockquote');
  expect(editor.state.doc.toString()).toBe('doc(paragraph("quoted"))');
});

test('the bullet_list command lifts out of a list from any item, not only the first', () => {
  const editor = open();
  type('one');
  run('bullet_list');
  editor.dispatch(editor.state.tr.split(editor.state.selection.from, 2));
  editor.dispatch(editor.state.tr.insertText('two'));
  caretInto('two');

  run('bullet_list');
  expect(editor.state.doc.toString()).toBe(
    'doc(bullet_list(list_item(paragraph("one"))), paragraph("two"))'
  );
  expect(activeMarks(editor.state)).not.toContain('bullet_list');
});

test('switching list type replaces the list rather than nesting one inside it', () => {
  const editor = open();
  type('one');
  run('bullet_list');
  expect(editor.state.doc.toString()).toBe('doc(bullet_list(list_item(paragraph("one"))))');

  run('ordered_list');
  expect(editor.state.doc.toString()).toBe('doc(ordered_list(list_item(paragraph("one"))))');
});

test('activeMarks reports a link mark covering the selection', () => {
  const editor = open();
  type('docs');
  const end = editor.state.doc.content.size;
  const href = { href: 'https://example.org' };
  editor.dispatch(editor.state.tr.addMark(1, end - 1, composerSchema.marks.link.create(href)));
  selectAll();

  expect(activeMarks(editor.state)).toContain('link');
});
