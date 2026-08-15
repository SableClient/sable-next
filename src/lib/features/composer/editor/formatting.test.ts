// @vitest-environment happy-dom

import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { afterEach, expect, test } from 'vitest';

import { formattingRules } from './formatting';
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
    state: EditorState.create({ schema: composerSchema, plugins: [formattingRules()] }),
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
