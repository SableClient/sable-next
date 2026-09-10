// @vitest-environment happy-dom

import { inputRules } from 'prosemirror-inputrules';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { afterEach, expect, test, vi } from 'vitest';

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
      plugins: [inputRules({ rules: formattingInputRules }), compositionInputRules()],
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

test('an autolink keeps the space that is already in the document', () => {
  open();
  commit('see https://example.org ');

  expect(editor().state.doc.textContent).toBe('see https://example.org ');
  expect(linkOn('https://example.org')).toBe('https://example.org');
});

test('a fence opens after composition when a space follows its language', () => {
  open();
  commit('```rust ');

  const block = editor().state.doc.firstChild;
  expect(block?.type.name).toBe('code_block');
  expect(block?.attrs.language).toBe('rust');
  expect(block?.textContent).toBe('');
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
