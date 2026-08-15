// @vitest-environment happy-dom

import type { Node as ProseMirrorNode } from 'prosemirror-model';
import { EditorState, TextSelection } from 'prosemirror-state';
import { expect, test } from 'vitest';

import type { AutocompleteQuery } from '../autocomplete';
import { queryKey, queryPlugin } from './query-plugin';
import { composerSchema } from './schema';

const { doc, paragraph, mention } = composerSchema.nodes;

function queryAfter(content: ProseMirrorNode[], caret?: number): AutocompleteQuery | null {
  const state = EditorState.create({
    doc: doc.create(null, [paragraph.create(null, content)]),
    plugins: [queryPlugin()],
  });
  const at = caret ?? state.doc.content.size - 1;
  const moved = state.apply(state.tr.setSelection(TextSelection.create(state.doc, at)));

  return queryKey.getState(moved) ?? null;
}

test('a sigil after whitespace opens a query with document offsets', () => {
  const query = queryAfter([composerSchema.text('hey @no')]);

  expect(query).toEqual({ sigil: '@', query: 'no', start: 5, end: 8 });
});

test('the offsets address the sigil itself, so a replacement consumes it', () => {
  const query = queryAfter([composerSchema.text('@no')]);

  expect(query).toEqual({ sigil: '@', query: 'no', start: 1, end: 4 });
});

test('an address glued to text opens nothing', () => {
  expect(queryAfter([composerSchema.text('mail@example.org')])).toBeNull();
});

test('a committed mention does not merge with the text that follows it', () => {
  const query = queryAfter([
    mention.create({ userId: '@one:example.org', name: 'One' }),
    composerSchema.text(':wa'),
  ]);

  expect(query).toEqual({ sigil: ':', query: 'wa', start: 2, end: 5 });
});

test('the query is read at the caret, not at the end of the paragraph', () => {
  expect(queryAfter([composerSchema.text('hey @no')], 7)).toEqual({
    sigil: '@',
    query: 'n',
    start: 5,
    end: 7,
  });
});

test('a caret on the sigil or before it opens nothing', () => {
  expect(queryAfter([composerSchema.text('hey @no')], 6)).toBeNull();
  expect(queryAfter([composerSchema.text('hey @no')], 4)).toBeNull();
});
