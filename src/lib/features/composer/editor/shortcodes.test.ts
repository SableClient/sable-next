// @vitest-environment happy-dom

import { inputRules, undoInputRule } from 'prosemirror-inputrules';
import { EditorState } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { afterEach, expect, test, vi } from 'vitest';

import type { PackImageView } from '#src/generated/PackImageView';

import { composerSchema } from './schema';
import { shortcodeInputRule } from './shortcodes';

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

function type(text: string): void {
  for (const char of text) {
    const target = editor();
    const { from, to } = target.state.selection;
    const handled = target.someProp('handleTextInput', (handler) =>
      handler(target, from, to, char, () => target.state.tr)
    );
    if (!handled) target.dispatch(target.state.tr.insertText(char, from, to));
  }
}

function compose(text: string): void {
  const target = editor();
  vi.useFakeTimers();
  target.dispatch(target.state.tr.insertText(text));
  target.dom.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
  vi.runAllTimers();
}

function open(emotes: PackImageView[] = []): EditorView {
  const host = document.createElement('div');
  document.body.append(host);
  view = new EditorView(host, {
    state: EditorState.create({
      schema: composerSchema,
      plugins: [inputRules({ rules: [shortcodeInputRule(() => emotes)] })],
    }),
  });
  return view;
}

function emote(shortcode: string): PackImageView {
  return {
    shortcode,
    url: `mxc://example.org/${shortcode}`,
    body: null,
    usage: ['emoticon'],
    info: null,
  };
}

test('a hand-typed shortcode becomes the emoji', () => {
  open();
  type('nice :joy: yes');

  expect(editor().state.doc.textContent).toBe('nice 😂 yes');
});

test('a composed shortcode becomes the emoji too', () => {
  open();
  compose(':joy:');

  expect(editor().state.doc.textContent).toBe('😂');
});

test('a pack emote wins over an emoji of the same name', () => {
  open([emote('joy')]);
  type(':joy:');

  const node = editor().state.doc.firstChild?.firstChild;
  expect(node?.type.name).toBe('emoticon');
  expect(node?.attrs.url).toBe('mxc://example.org/joy');
});

test('a shortcode straight after an emote still resolves', () => {
  open([emote('wave')]);
  type(':wave::joy:');

  const paragraph = editor().state.doc.firstChild;
  expect(paragraph?.childCount).toBe(2);
  expect(paragraph?.child(0).type.name).toBe('emoticon');
  expect(paragraph?.child(1).text).toBe('😂');
});

test('an unknown shortcode stays as typed', () => {
  open();
  type(':notanemoji:');

  expect(editor().state.doc.textContent).toBe(':notanemoji:');
});

test('a colon that does not start a word is left alone', () => {
  open();
  type('at 10:30: sharp');

  expect(editor().state.doc.textContent).toBe('at 10:30: sharp');
});

test('an inline code span keeps the shortcode literal', () => {
  open();
  const code = composerSchema.marks.code.create();
  editor().dispatch(editor().state.tr.addStoredMark(code));
  type(':joy:');

  expect(editor().state.doc.textContent).toBe(':joy:');
});

test('backspace undoes the replacement back to the text', () => {
  open();
  type(':joy:');
  expect(editor().state.doc.textContent).toBe('😂');

  expect(undoInputRule(editor().state, editor().dispatch.bind(editor()))).toBe(true);
  expect(editor().state.doc.textContent).toBe(':joy:');
});
