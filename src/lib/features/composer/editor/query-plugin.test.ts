// @vitest-environment happy-dom

import type { Node as ProseMirrorNode } from 'prosemirror-model';
import { EditorState, TextSelection } from 'prosemirror-state';
import { expect, test } from 'vitest';

import type { AutocompleteQuery } from '../autocomplete';
import { queryKey, queryPlugin } from './query-plugin';
import { composerSchema } from './schema';

const { doc, paragraph, mention } = composerSchema.nodes;

test('quick reactions use document offsets and cannot consume trailing text', () => {
  expect(queryAfter([composerSchema.text('+:wa')])).toEqual({
    sigil: '+:',
    query: 'wa',
    start: 1,
    end: 5,
  });
  expect(queryAfter([composerSchema.text('+:wa more')], 5)).toBeNull();
  expect(
    queryAfter([
      mention.create({ userId: '@one:example.org', name: 'One' }),
      composerSchema.text('+:wa'),
    ])
  ).toBeNull();
});

test('quick reactions cannot replace a draft with multiple paragraphs', () => {
  for (const paragraphs of [
    ['hello', '+:wa'],
    ['+:wa', 'hello'],
  ]) {
    const state = EditorState.create({
      doc: doc.create(
        null,
        paragraphs.map((text) => paragraph.create(null, composerSchema.text(text)))
      ),
      plugins: [queryPlugin()],
    });
    const at = paragraphs[0] === '+:wa' ? 5 : state.doc.content.size - 1;
    const moved = state.apply(state.tr.setSelection(TextSelection.create(state.doc, at)));
    expect(queryKey.getState(moved)).toBeNull();
  }
});

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

test('a room query spans spaces and formatting with document offsets', () => {
  expect(
    queryAfter([
      composerSchema.text('join #Sable '),
      composerSchema.text('Dev', [composerSchema.marks.strong.create()]),
    ])
  ).toEqual({ sigil: '#', query: 'Sable Dev', start: 6, end: 16 });
});

test('a room query cannot cross a soft break or an inline atom', () => {
  for (const boundary of [
    composerSchema.nodes.hard_break.create(),
    mention.create({ userId: '@one:example.org', name: 'One' }),
  ]) {
    expect(
      queryAfter([composerSchema.text('#Sable'), boundary, composerSchema.text(' Dev')])
    ).toBeNull();
    expect(queryAfter([boundary, composerSchema.text('#Sable Dev')])).toEqual({
      sigil: '#',
      query: 'Sable Dev',
      start: 2,
      end: 12,
    });
  }
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

test('nothing opens inside a code block', () => {
  const state = EditorState.create({
    doc: doc.create(null, [
      composerSchema.nodes.code_block.create(null, composerSchema.text('x :smi')),
    ]),
    plugins: [queryPlugin()],
  });
  const moved = state.apply(
    state.tr.setSelection(TextSelection.create(state.doc, state.doc.content.size - 1))
  );

  expect(queryKey.getState(moved)).toBeNull();
});

test('nothing opens inside a code span', () => {
  expect(
    queryAfter([composerSchema.text('run @no', [composerSchema.marks.code.create()])])
  ).toBeNull();
});
