import { afterEach, expect, test, vi } from 'vitest';

import { queryWords } from './query-words';

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
