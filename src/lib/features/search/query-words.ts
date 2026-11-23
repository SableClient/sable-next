export const UNSPACED = /[\p{scx=Han}\p{scx=Hiragana}\p{scx=Katakana}]/u;

interface WordSegmenter {
  segment(text: string): Iterable<{ segment: string; isWordLike?: boolean }>;
}

function platformSegmenter(): WordSegmenter | undefined {
  return typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'word' })
    : undefined;
}

export function isUnspaced(word: string): boolean {
  return UNSPACED.test(word);
}

/**
 * The words of a search query. Chinese and Japanese are cut where the
 * platform's word segmenter says; without one, each space-separated part is
 * one word.
 */
export function queryWords(
  text: string,
  segmenter: WordSegmenter | undefined = platformSegmenter()
): string[] {
  return text
    .split(/\s+/)
    .filter((part) => part !== '')
    .flatMap((part) =>
      segmenter && isUnspaced(part)
        ? Array.from(segmenter.segment(part))
            .filter((segment) => segment.isWordLike)
            .map((segment) => segment.segment)
        : [part]
    );
}
