// @vitest-environment happy-dom

import fc from 'fast-check';
import { TextSelection, type EditorState, type Selection } from 'prosemirror-state';
import { afterEach, expect, test } from 'vitest';

import type { ComposerEditor } from './composer-editor';
import {
  backspace,
  bold,
  cm,
  codeBlock,
  enter,
  indent,
  inlineCode,
  italic,
  orderedList,
  press,
  quote,
  replaceText,
  resetModel,
  softBreak,
  strike,
  unindent,
  unorderedList,
  view,
} from './model-harness';
import { parseMatrixHtml } from './schema';
import { serializeComposer } from './serialize';

afterEach(resetModel);

const typed = ['a', 'ab ', '> ', '- ', '1. ', '# ', '```'];
const pasted = ['> quoted\n\nafter', '- one\n- two\n\n', 'line\nnext **bold**'];

function paste(editor: ComposerEditor, text: string): void {
  const editorView = view(editor);
  const slice = editorView.someProp('clipboardTextParser', (parse) =>
    parse(text, editorView.state.selection.$from, false, editorView)
  );
  if (slice) editorView.dispatch(editorView.state.tr.replaceSelection(slice));
}

function select(editor: ComposerEditor, at: (state: EditorState) => Selection): void {
  const editorView = view(editor);
  editorView.dispatch(editorView.state.tr.setSelection(at(editorView.state)));
}

const operations: ((editor: ComposerEditor) => void)[] = [
  softBreak,
  enter,
  backspace,
  indent,
  unindent,
  quote,
  orderedList,
  unorderedList,
  codeBlock,
  bold,
  italic,
  strike,
  inlineCode,
  ...typed.map((text) => (editor: ComposerEditor) => {
    replaceText(editor, text);
  }),
  ...pasted.map((text) => (editor: ComposerEditor) => {
    paste(editor, text);
  }),
  (editor) => {
    view(editor).pasteText('a\n\n\nb');
  },
  (editor) => {
    press(editor, 'z', { mod: true });
  },
  (editor) => {
    press(editor, 'z', { mod: true, shift: true });
  },
  (editor) => {
    select(editor, ({ doc, selection }) =>
      TextSelection.between(doc.resolve(Math.max(0, selection.head - 3)), selection.$head)
    );
  },
  (editor) => {
    select(editor, ({ doc }) => TextSelection.atStart(doc));
  },
  (editor) => {
    select(editor, ({ doc }) => TextSelection.atEnd(doc));
  },
];

const starts = [
  '<p>a|</p>',
  '<blockquote><p>a|</p></blockquote>',
  '<ul><li>a|</li></ul>',
  '<p>a|</p><blockquote><p>b</p></blockquote>',
  '<pre><code>x|</code></pre>',
  '<h1>t|</h1><p>b</p>',
  '<ul><li><p>a</p><ul><li><p>b|</p></li></ul></li></ul>',
];

function trailingEmptyParagraphs(editor: ComposerEditor): number {
  const { doc } = view(editor).state;
  let count = 0;
  for (let index = doc.childCount - 1; index >= 0; index -= 1) {
    const child = doc.child(index);
    if (child.type.name !== 'paragraph' || child.content.size > 0) break;
    count += 1;
  }
  return count;
}

test('any sequence of edits sends clean html that survives an edit', () => {
  fc.assert(
    fc.property(
      fc.constantFrom(...starts),
      fc.array(fc.integer({ min: 0, max: operations.length - 1 }), { maxLength: 25 }),
      (start, steps) => {
        const editor = cm(start);
        try {
          for (const step of steps) {
            operations[step](editor);
            expect(trailingEmptyParagraphs(editor), view(editor).state.doc.toString()).toBeLessThan(
              2
            );
            const { formatted } = serializeComposer(view(editor).state.doc);
            expect(formatted ?? '').not.toMatch(/<br>\s*<\/(?:p|h[1-6]|li)>|<p><\/p>\s*$/);
          }
          const { formatted } = serializeComposer(view(editor).state.doc);
          if (formatted !== null) {
            expect(serializeComposer(parseMatrixHtml(formatted)).formatted, formatted).toBe(
              formatted
            );
          }
        } finally {
          resetModel();
        }
      }
    ),
    { numRuns: 500 }
  );
});
