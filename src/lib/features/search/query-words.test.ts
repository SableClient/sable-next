import { readFileSync } from 'node:fs';

import { afterEach, expect, test, vi } from 'vitest';

import { queryWords, UNSPACED } from './query-words';

// Cuts the way ICU 78 cuts these strings.
const CUTS: Record<string, string[]> = {
  日本語勉強: ['日本語', '勉強'],
  東京都: ['東京', '都'],
  '東京、大阪': ['東京', '、', '大阪'],
};

const segmenter = {
  segment: (text: string) =>
    (CUTS[text] ?? [text]).map((segment) => ({
      segment,
      isWordLike: /[\p{L}\p{N}]/u.test(segment),
    })),
};

afterEach(() => {
  vi.unstubAllGlobals();
});

test('a Chinese or Japanese query is sent as the segments the segmenter finds', () => {
  expect(queryWords('日本語勉強', segmenter)).toEqual(['日本語', '勉強']);
  expect(queryWords('東京都', segmenter)).toEqual(['東京', '都']);
});

test('punctuation is dropped and spaced words are left alone', () => {
  expect(queryWords('東京、大阪', segmenter)).toEqual(['東京', '大阪']);
  expect(queryWords(' deploy  日本語勉強 ', segmenter)).toEqual(['deploy', '日本語', '勉強']);
});

test('without Intl.Segmenter each space-separated part is one word', () => {
  vi.stubGlobal('Intl', { ...Intl, Segmenter: undefined });

  expect(queryWords('日本語勉強 deploy')).toEqual(['日本語勉強', 'deploy']);
});

test('the scripts without spaces are the ones the index cuts by', () => {
  const [unspaced = [], spaced = []] = readFileSync(
    'crates/sable-search/tests/fixtures/unspaced.txt',
    'utf8'
  )
    .trim()
    .split('\n')
    .map((line) => line.split(' ').slice(1));

  expect(unspaced.filter((character) => !UNSPACED.test(character))).toEqual([]);
  expect(spaced.filter((character) => UNSPACED.test(character))).toEqual([]);
});

test('a Thai query is sent as the segments the segmenter finds', () => {
  const thai = {
    segment: () => [
      { segment: 'สวัสดี', isWordLike: true },
      { segment: 'ครับ', isWordLike: true },
    ],
  };

  expect(queryWords('สวัสดีครับ', thai)).toEqual(['สวัสดี', 'ครับ']);
});
