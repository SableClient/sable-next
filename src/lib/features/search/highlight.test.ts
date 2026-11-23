import { expect, test } from 'vitest';

import { highlightSegments, snippetAround } from './highlight';

const marked = (body: string, terms: string[]) =>
  highlightSegments(body, terms)
    .filter((segment) => segment.match)
    .map((segment) => segment.text);

test('no terms leaves the body in one unmatched segment', () => {
  expect(highlightSegments('the deploy broke', [])).toEqual([
    { text: 'the deploy broke', match: false },
  ]);
});

test('a term is split out and marked, case-insensitively', () => {
  expect(highlightSegments('The Deploy broke', ['deploy'])).toEqual([
    { text: 'The ', match: false },
    { text: 'Deploy', match: true },
    { text: ' broke', match: false },
  ]);
});

test('several terms are all marked', () => {
  const segments = highlightSegments('deploy the pipeline', ['deploy', 'pipeline']);

  expect(segments.filter((segment) => segment.match).map((segment) => segment.text)).toEqual([
    'deploy',
    'pipeline',
  ]);
});

test('a term full of regex metacharacters neither throws nor matches everything', () => {
  expect(highlightSegments('a (b) c', ['.*+?'])).toEqual([{ text: 'a (b) c', match: false }]);
});

test('phrase metacharacters are matched literally', () => {
  const segments = highlightSegments('read the c++ guide, not the ccc guide', ['c++ guide']);
  expect(segments.filter((segment) => segment.match).map((segment) => segment.text)).toEqual([
    'c++ guide',
  ]);
});

test('a term that does not occur leaves the body whole', () => {
  expect(highlightSegments('nothing here', ['absent'])).toEqual([
    { text: 'nothing here', match: false },
  ]);
});

test('a two-letter term does not match every word sharing its prefix', () => {
  expect(
    highlightSegments('at the attic', ['at'])
      .filter((segment) => segment.match)
      .map((segment) => segment.text)
  ).toEqual(['at']);
});

test('only whole words are marked', () => {
  expect(
    highlightSegments('redeploy the deploy', ['deploy'])
      .filter((segment) => segment.match)
      .map((segment) => segment.text)
  ).toEqual(['deploy']);
});

test('a long body is windowed around the first match', () => {
  const body = `${'filler '.repeat(40)}needle${' tail'.repeat(40)}`;
  const snippet = snippetAround(body, ['needle']);

  expect(snippet.clippedStart).toBe(true);
  expect(snippet.clippedEnd).toBe(true);
  expect(snippet.segments.some((segment) => segment.match)).toBe(true);
  expect(snippet.segments.map((segment) => segment.text).join('').length).toBeLessThan(body.length);
});

test('a short body is not clipped', () => {
  const snippet = snippetAround('deploy broke', ['deploy']);

  expect(snippet.clippedStart).toBe(false);
  expect(snippet.clippedEnd).toBe(false);
});

test('a quoted phrase is marked as one span, not word by word', () => {
  expect(highlightSegments('the General message 1 here', ['General message 1'])).toEqual([
    { text: 'the ', match: false },
    { text: 'General message 1', match: true },
    { text: ' here', match: false },
  ]);
});

test('a phrase tolerates differing runs of whitespace', () => {
  expect(
    highlightSegments('a  deploy   broke b', ['deploy broke'])
      .filter((segment) => segment.match)
      .map((segment) => segment.text)
  ).toEqual(['deploy   broke']);
});

test('a phrase and a loose term both mark without overlapping', () => {
  expect(
    highlightSegments('deploy broke the pipeline', ['deploy broke', 'pipeline'])
      .filter((segment) => segment.match)
      .map((segment) => segment.text)
  ).toEqual(['deploy broke', 'pipeline']);
});

test('a body that fits the window is never clipped, wherever the match sits', () => {
  const body = `${'x'.repeat(96)} needle`;
  const snippet = snippetAround(body, ['needle']);

  expect(body.length).toBeLessThanOrEqual(180);
  expect(snippet.clippedStart).toBe(false);
  expect(snippet.clippedEnd).toBe(false);
  expect(snippet.segments.map((segment) => segment.text).join('')).toBe(body);
});

test('a Japanese or Chinese term inside an unspaced sentence is marked', () => {
  expect(marked('日本語で検索を使う', ['検索'])).toEqual(['検索']);
  expect(marked('ありがとうございます', ['ありがとう'])).toEqual(['ありがとう']);
  expect(marked('今天我们讨论中文搜索功能', ['搜索'])).toEqual(['搜索']);
  expect(marked('メロンとソーセージ', ['メッセージ'])).toEqual([]);
  expect(marked('日本語を勉強する', ['日本語', '勉強'])).toEqual(['日本語', '勉強']);
});

test('a Thai or Lao term inside an unspaced sentence is marked', () => {
  expect(marked('ไปไหน', ['ไหน'])).toEqual(['ไหน']);
  expect(marked('ສະບາຍດີ', ['ບາຍ'])).toEqual(['ບາຍ']);
});

test('only the words the core matched are marked', () => {
  expect(marked('please deligate this', ['delegate'])).toEqual([]);
  expect(marked('please deligate this', ['deligate'])).toEqual(['deligate']);
  expect(marked('the category list', ['category'])).toEqual(['category']);
  expect(marked('Rustを使う', ['Rust'])).toEqual(['Rust']);
});
