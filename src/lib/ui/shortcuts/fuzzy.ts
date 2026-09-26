import uFuzzy from '@leeoniya/ufuzzy';

const matcher = new uFuzzy({
  unicode: true,
  interSplit: "[^\\p{L}\\d']+",
  intraSplit: '\\p{Ll}\\p{Lu}',
  intraBound: '\\p{L}\\d|\\d\\p{L}|\\p{Ll}\\p{Lu}',
  intraChars: "[\\p{L}\\d']",
  intraContr: "'\\p{L}{1,2}\\b",
  intraIns: Infinity,
});

function search(haystack: string[], query: string): { idx: number; ranges: number[] }[] {
  const result = matcher.search(uFuzzy.latinize(haystack), uFuzzy.latinize(query));
  if (result[1] === null) return [];
  const [, info, order] = result;
  return order.map((rank) => ({ idx: info.idx[rank], ranges: info.ranges[rank] }));
}

export function fuzzyFilter<T>(
  items: readonly T[],
  query: string,
  text: (item: T) => string,
  limit: number
): T[] {
  const trimmed = query.trim();
  if (trimmed === '') return items.slice(0, limit);

  return search(items.map(text), trimmed)
    .slice(0, limit)
    .map(({ idx }) => items[idx]);
}

export function fuzzyMatchParts(text: string, query: string): { text: string; match: boolean }[] {
  const hit = query.trim() === '' ? undefined : search([text], query.trim()).at(0);
  if (hit === undefined) return [{ text, match: false }];

  const parts: { text: string; match: boolean }[] = [];
  let at = 0;
  for (let index = 0; index < hit.ranges.length; index += 2) {
    const start = hit.ranges[index];
    const end = hit.ranges[index + 1];
    if (start > at) parts.push({ text: text.slice(at, start), match: false });
    parts.push({ text: text.slice(start, end), match: true });
    at = end;
  }
  if (at < text.length) parts.push({ text: text.slice(at), match: false });
  return parts;
}
