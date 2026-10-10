// @vitest-environment happy-dom

import { inputRules } from 'prosemirror-inputrules';
import { EditorState, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { afterEach, expect, test, vi } from 'vitest';

import { autolinks } from './autolinks';
import { compositionInputRules } from './composition-rules';
import { formattingInputRules } from './formatting';
import { composerSchema } from './schema';

let view: EditorView | undefined;

afterEach(() => {
  view?.destroy();
  view = undefined;
  document.body.replaceChildren();
  vi.useRealTimers();
});

function editor(): EditorView {
  if (!view) throw new Error('no editor');
  return view;
}

function open(): EditorView {
  const host = document.createElement('div');
  document.body.append(host);
  view = new EditorView(host, {
    state: EditorState.create({
      schema: composerSchema,
      plugins: [inputRules({ rules: formattingInputRules }), autolinks(), compositionInputRules()],
    }),
  });
  return view;
}

function commit(text: string): void {
  const target = editor();
  vi.useFakeTimers();
  target.dom.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
  vi.advanceTimersByTime(0);
  target.dispatch(target.state.tr.insertText(text));
  vi.runAllTimers();
}

function marksOn(word: string): string[] {
  const names: string[] = [];
  editor().state.doc.descendants((node) => {
    if (node.isText && node.text === word) names.push(...node.marks.map((mark) => mark.type.name));
  });
  return names;
}

function linkOn(word: string): string | null {
  let href: string | null = null;
  editor().state.doc.descendants((node) => {
    if (!node.isText || node.text !== word) return;
    const link = node.marks.find((mark) => mark.type.name === 'link');
    if (link) href = link.attrs.href as string;
  });
  return href;
}

test('a mark whose delimiters land after the composition ended still applies', () => {
  open();
  commit('~~Strikethrough~~');

  expect(editor().state.doc.textContent).toBe('Strikethrough');
  expect(marksOn('Strikethrough')).toEqual(['strike']);
});

test('composed text between markers is formatted', () => {
  const target = open();
  target.dispatch(target.state.tr.insertText('****'));
  target.dispatch(target.state.tr.setSelection(TextSelection.create(target.state.doc, 3)));
  commit('テスト');

  expect(target.state.doc.textContent).toBe('テスト');
  expect(marksOn('テスト')).toEqual(['strong']);
  expect(target.state.selection.from).toBe(4);
});

test('an autolink keeps the space that is already in the document', () => {
  open();
  commit('see https://example.org ');

  expect(editor().state.doc.textContent).toBe('see https://example.org ');
  expect(linkOn('https://example.org')).toBe('https://example.org');
});

test('a composed fence stays literal', () => {
  open();
  commit('```rust ');

  const block = editor().state.doc.firstChild;
  expect(block?.type.name).toBe('paragraph');
  expect(block?.textContent).toBe('```rust ');
});

test('the flush is read once, so the next edit runs no rule', () => {
  open();
  commit('a ~~b~~');
  editor().dispatch(editor().state.tr.insertText(' `c`'));

  expect(editor().state.doc.textContent).toBe('a b `c`');
});

test('an edit with no composition before it runs no rule', () => {
  open();
  editor().dispatch(editor().state.tr.insertText('~~b~~'));

  expect(editor().state.doc.textContent).toBe('~~b~~');
});

test('a composed fence preserves the soft line', () => {
  open();
  editor().dispatch(
    editor().state.tr.insertText('look:').insert(6, composerSchema.nodes.hard_break.create())
  );
  commit('```rust ');

  const doc = editor().state.doc;
  expect(doc.childCount).toBe(1);
  expect(doc.firstChild?.textContent).toBe('look:```rust ');
  expect(doc.firstChild?.child(1).type.name).toBe('hard_break');
});

test('a bullet composed on a soft line makes a list after the text', () => {
  open();
  editor().dispatch(
    editor().state.tr.insertText('list:').insert(6, composerSchema.nodes.hard_break.create())
  );
  commit('- ');

  const doc = editor().state.doc;
  expect(doc.firstChild?.textContent).toBe('list:');
  expect(doc.child(1).type.name).toBe('bullet_list');
});
