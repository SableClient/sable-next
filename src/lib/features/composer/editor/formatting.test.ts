// @vitest-environment happy-dom

import { inputRules } from 'prosemirror-inputrules';
import { EditorState, Selection, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { afterEach, describe, expect, test } from 'vitest';

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

test('a spoiler typed between double bars becomes the spoiler mark', () => {
  open();
  type('the ||butler|| did it');

  expect(view?.state.doc.textContent).toBe('the butler did it');
  expect(marksOn('butler')).toEqual(['spoiler']);
});

test('double bars around spaces stay literal', () => {
  open();
  type('a || b || c');

  expect(view?.state.doc.textContent).toBe('a || b || c');
});

test('a heading marker at the line start becomes a heading', () => {
  open();
  type('## Title');

  expect(view?.state.doc.firstChild?.type.name).toBe('heading');
  expect(view?.state.doc.firstChild?.attrs.level).toBe(2);
  expect(view?.state.doc.textContent).toBe('Title');
});

test('a subtext marker at the line start becomes subtext', () => {
  open();
  type('-# small print');

  expect(view?.state.doc.firstChild?.type.name).toBe('subtext');
  expect(view?.state.doc.textContent).toBe('small print');
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

test('a typed address becomes a link once it is finished', () => {
  open();
  type('see https://example.org/a_b ');

  const marks = marksOn('https://example.org/a_b');
  expect(marks).toEqual(['link']);
  expect(view?.state.doc.textContent).toBe('see https://example.org/a_b ');
});

test('a bare host is linked with a scheme it can be opened with', () => {
  open();
  type('www.example.org ');

  let href: string | null = null;
  view?.state.doc.descendants((node) => {
    const mark = node.marks.find((candidate) => candidate.type.name === 'link');
    if (mark) href = mark.attrs.href as string;
  });
  expect(href).toBe('https://www.example.org');
});

test('an address inside a code span is left alone', () => {
  open();
  type('`https://example.org` ');

  expect(marksOn('https://example.org')).toEqual(['code']);
});

test('a fence opens a block when a space follows its language', () => {
  open();
  type('```rust ');

  const block = view?.state.doc.firstChild;
  expect(block?.type.name).toBe('code_block');
  expect(block?.attrs.language).toBe('rust');
  expect(block?.textContent).toBe('');
});

test('a bare fence opens a block when followed by a space', () => {
  open();
  type('``` ');

  const block = view?.state.doc.firstChild;
  expect(block?.type.name).toBe('code_block');
  expect(block?.attrs.language).toBe('');
  expect(block?.textContent).toBe('');
});

test('a fence stays text until enter or a following space opens it', () => {
  open();
  type('```go');

  expect(view?.state.doc.firstChild?.type.name).toBe('paragraph');
  expect(view?.state.doc.textContent).toBe('```go');
});

test('three dashes become a rule rather than a paragraph of dashes', () => {
  open();
  type('---');

  expect(view?.state.doc.firstChild?.type.name).toBe('horizontal_rule');
});

test.each(['2 * 3 * 4', 'a ** b ** c', 'x ~~ y ~~ z', 'p _ q _ r'])(
  'delimiters beside whitespace do not format %j',
  (text) => {
    open();
    type(text);

    expect(view?.state.doc.textContent).toBe(text);
  }
);

test('the code_block command spells atoms out instead of dropping them', () => {
  open();
  type('hey ');
  const editor = view;
  if (!editor) throw new Error('no editor');
  editor.dispatch(
    editor.state.tr.replaceSelectionWith(
      composerSchema.nodes.mention.create({ userId: '@a:example.org', name: 'A' })
    )
  );
  formatCommands.code_block(editor.state, editor.dispatch);

  expect(editor.state.doc.firstChild?.type.name).toBe('code_block');
  expect(editor.state.doc.firstChild?.textContent).toBe('hey A');
});

describe('toolbar block insertion', () => {
  test('a horizontal rule is inserted and the caret lands after it', () => {
    open();
    type('above');
    const editor = view;
    if (!editor) throw new Error('no editor');
    expect(formatCommands.horizontal_rule(editor.state, editor.dispatch)).toBe(true);

    expect(editor.state.doc.child(1).type.name).toBe('horizontal_rule');
  });

  test('a table arrives with a header row and two body rows of two cells', () => {
    open();
    const editor = view;
    if (!editor) throw new Error('no editor');
    expect(formatCommands.table(editor.state, editor.dispatch)).toBe(true);

    const table = editor.state.doc.firstChild;
    expect(table?.type.name).toBe('table');
    expect(table?.childCount).toBe(3);
    expect(table?.firstChild?.firstChild?.type.name).toBe('table_header');
    expect(table?.child(1).firstChild?.type.name).toBe('table_cell');
    expect(table?.child(1).childCount).toBe(2);
  });

  test('a collapsible section arrives with a summary and a body', () => {
    open();
    const editor = view;
    if (!editor) throw new Error('no editor');
    expect(formatCommands.details(editor.state, editor.dispatch)).toBe(true);

    const details = editor.state.doc.firstChild;
    expect(details?.type.name).toBe('details');
    expect(details?.firstChild?.type.name).toBe('summary');
    expect(details?.child(1).type.name).toBe('paragraph');
  });
});

describe('activeMarks reports the block the caret is in', () => {
  function activeAfter(command: keyof typeof formatCommands): string[] {
    open();
    type('x');
    const editor = view;
    if (!editor) throw new Error('no editor');
    formatCommands[command](editor.state, editor.dispatch);
    return activeMarks(editor.state);
  }

  test.each([
    ['bullet_list', 'bullet_list'],
    ['ordered_list', 'ordered_list'],
    ['blockquote', 'blockquote'],
    ['code_block', 'code_block'],
    ['heading1', 'heading1'],
    ['heading2', 'heading2'],
    ['heading3', 'heading3'],
  ] as const)('%s', (command, expected) => {
    expect(activeAfter(command)).toEqual([expected]);
  });

  test('a table and a section report themselves once the caret is inside', () => {
    open();
    const editor = view;
    if (!editor) throw new Error('no editor');
    formatCommands.table(editor.state, editor.dispatch);
    editor.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 3)));
    expect(activeMarks(editor.state)).toEqual(['table']);

    open();
    const second = view;
    if (!second) throw new Error('no editor');
    formatCommands.details(second.state, second.dispatch);
    second.dispatch(second.state.tr.setSelection(TextSelection.create(second.state.doc, 2)));
    expect(activeMarks(second.state)).toEqual(['details']);
  });
});

describe('autolink edge cases', () => {
  test('an address already inside a link is not linked again', () => {
    open();
    const editor = view;
    if (!editor) throw new Error('no editor');
    editor.dispatch(
      editor.state.tr
        .insertText('https://a.b')
        .addMark(1, 12, composerSchema.marks.link.create({ href: 'https://other' }))
    );
    type(' ');

    const hrefs: string[] = [];
    editor.state.doc.descendants((node) => {
      for (const mark of node.marks)
        if (mark.type.name === 'link') hrefs.push(mark.attrs.href as string);
    });
    expect(hrefs).toEqual(['https://other']);
  });

  test('a closing paren ends the address and is kept', () => {
    open();
    type('(see https://a.b/c) ok');

    expect(view?.state.doc.textContent).toBe('(see https://a.b/c) ok');
    expect(marksOn('https://a.b/c')).toEqual(['link']);
  });

  test.each(['.', ',', '?', '!', ':', ';', '."'])('trailing %j is left out of the link', (tail) => {
    open();
    type(`go to https://a.b/c${tail} now`);

    expect(view?.state.doc.textContent).toBe(`go to https://a.b/c${tail} now`);
    expect(marksOn('https://a.b/c')).toEqual(['link']);
  });
});

describe('ordered list numbering', () => {
  test('a number continuing the list joins it, another number starts a new list', () => {
    open();
    type('1. a');
    const editor = view;
    if (!editor) throw new Error('no editor');
    editor.dispatch(
      editor.state.tr.insert(editor.state.doc.content.size, composerSchema.nodes.paragraph.create())
    );
    editor.dispatch(editor.state.tr.setSelection(Selection.atEnd(editor.state.doc)));
    type('2. b');
    expect(editor.state.doc.childCount).toBe(1);
    expect(editor.state.doc.firstChild?.childCount).toBe(2);

    editor.dispatch(
      editor.state.tr.insert(editor.state.doc.content.size, composerSchema.nodes.paragraph.create())
    );
    editor.dispatch(editor.state.tr.setSelection(Selection.atEnd(editor.state.doc)));
    type('7. c');
    expect(editor.state.doc.childCount).toBe(2);
    expect(editor.state.doc.child(1).attrs.order).toBe(7);
  });
});

describe('mark rules', () => {
  test('an empty pair of delimiters is left alone', () => {
    open();
    type('a **** b');
    expect(view?.state.doc.textContent).toBe('a **** b');
  });

  test('a rule typed inside a heading applies there', () => {
    open();
    type('# a **b**');
    expect(view?.state.doc.firstChild?.type.name).toBe('heading');
    expect(marksOn('b')).toEqual(['strong']);
  });
});
