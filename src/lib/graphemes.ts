export const graphemes = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** The longest prefix of `text` made of whole grapheme clusters and at most `maxLength` UTF-16 units. */
export function truncateGraphemes(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  let end = 0;
  for (const { index, segment } of graphemes.segment(text)) {
    if (index + segment.length > maxLength) break;
    end = index + segment.length;
  }
  return text.slice(0, end);
}
