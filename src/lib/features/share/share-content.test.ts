import { expect, test } from 'vitest';

import type { SharedBatch } from '#lib/platform/share-target.js';

import {
  appendPlainText,
  collectShareFiles,
  collectShareText,
  displayFileName,
  isShareDeepLink,
  mergeShareBatches,
  plainTextDoc,
} from './share-content.js';

const batch = (batchId: string, items: SharedBatch['items']): SharedBatch => ({ batchId, items });

test('merging keeps a batch the reader already holds from arriving twice', () => {
  const held = [batch('a', []), batch('b', [])];
  const merged = mergeShareBatches(held, [batch('b', []), batch('c', [])]);

  expect(merged.map((entry) => entry.batchId)).toEqual(['a', 'b', 'c']);
});

test('text collects urls and text, and drops empty items', () => {
  const collected = collectShareText([
    batch('a', [
      { kind: 'text', text: 'hello' },
      { kind: 'text', text: '' },
      { kind: 'url', text: 'https://example.org' },
      { kind: 'file', fileName: '0-photo.png' },
    ]),
  ]);

  expect(collected).toBe('hello\nhttps://example.org');
});

test('files carry their batch, so each is read from the right staging directory', () => {
  const files = collectShareFiles([
    batch('a', [{ kind: 'file', fileName: '0-one.png', mime: 'image/png' }]),
    batch('b', [{ kind: 'file', fileName: '1-two.pdf' }]),
  ]);

  expect(files).toEqual([
    { batchId: 'a', fileName: '0-one.png', mime: 'image/png' },
    { batchId: 'b', fileName: '1-two.pdf', mime: undefined },
  ]);
});

test('the staging index prefix is stripped for display', () => {
  expect(displayFileName('12-holiday.png')).toBe('holiday.png');
  expect(displayFileName('holiday.png')).toBe('holiday.png');
});

test('only the share scheme counts as a share deep link', () => {
  expect(isShareDeepLink('sable://share/abc')).toBe(true);
  expect(isShareDeepLink('sable://room/abc')).toBe(false);
});

test('a plain-text doc keeps blank lines as empty paragraphs', () => {
  expect(plainTextDoc('one\n\ntwo')).toEqual({
    type: 'doc',
    content: [
      { type: 'paragraph', content: [{ type: 'text', text: 'one' }] },
      { type: 'paragraph' },
      { type: 'paragraph', content: [{ type: 'text', text: 'two' }] },
    ],
  });
});

test('a share appends to a draft rather than replacing it', () => {
  const existing = plainTextDoc('typed');
  const appended = appendPlainText(existing, 'shared');

  expect(appended.content).toHaveLength(2);
  expect(appended.content[0]).toEqual({
    type: 'paragraph',
    content: [{ type: 'text', text: 'typed' }],
  });
});

test('appending to something that is not a doc starts a fresh one', () => {
  expect(appendPlainText(null, 'shared')).toEqual(plainTextDoc('shared'));
  expect(appendPlainText({ type: 'paragraph' }, 'shared')).toEqual(plainTextDoc('shared'));
});

test('appending nothing leaves the draft untouched', () => {
  const existing = plainTextDoc('typed');
  expect(appendPlainText(existing, '')).toBe(existing);
});
