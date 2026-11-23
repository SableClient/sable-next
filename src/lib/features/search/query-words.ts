/**
 * A character of a script written without spaces between words: Chinese,
 * Japanese kana, Thai, Lao, Myanmar and Khmer. The same set as `is_unspaced` in
 * crates/sable-search/src/tokenize.rs, which the index cuts such runs by.
 */
export const UNSPACED =
  /[\u2E80-\u2E99\u2E9B-\u2EF3\u2F00-\u2FD5\u3005\u3007\u3021-\u3029\u3038-\u303B\u3040-\u30FF\u3400-\u4DB5\u4E00-\u9FCC\uF900-\uFA6D\uFA70-\uFAD9\u0E00-\u0EFF\u1000-\u109F\uA9E0-\uA9FF\uAA60-\uAA7F\u1780-\u17FF\u19E0-\u19FF]/u;

interface WordSegmenter {
  segment(text: string): Iterable<{ segment: string; isWordLike?: boolean }>;
}

function platformSegmenter(): WordSegmenter | undefined {
  return typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'word' })
    : undefined;
}

/**
 * The words of a search query. A script written without spaces is cut where
 * the platform's word segmenter says; without one, each space-separated part
 * is one word.
 */
export function queryWords(
  text: string,
  segmenter: WordSegmenter | undefined = platformSegmenter()
): string[] {
  return text
    .split(/\s+/)
    .filter((part) => part !== '')
    .flatMap((part) =>
      segmenter && UNSPACED.test(part)
        ? Array.from(segmenter.segment(part))
            .filter((segment) => segment.isWordLike)
            .map((segment) => segment.segment)
        : [part]
    );
}
