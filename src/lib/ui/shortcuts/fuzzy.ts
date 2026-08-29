export function fuzzyScore(text: string, query: string): number | null {
  if (query === '') return 0;

  const haystack = text.toLocaleLowerCase();
  const needle = query.toLocaleLowerCase();

  let score = 0;
  let needleIndex = 0;
  let previousMatchIndex = -1;

  for (let index = 0; index < haystack.length && needleIndex < needle.length; index += 1) {
    if (haystack[index] !== needle[needleIndex]) continue;

    score += index === 0 ? 3 : 1;
    if (previousMatchIndex === index - 1) score += 2;

    previousMatchIndex = index;
    needleIndex += 1;
  }

  return needleIndex === needle.length ? score : null;
}

export function fuzzyFilter<T>(
  items: readonly T[],
  query: string,
  text: (item: T) => string,
  limit: number
): T[] {
  const trimmed = query.trim();
  if (trimmed === '') return items.slice(0, limit);

  const scored: { item: T; score: number }[] = [];
  for (const item of items) {
    const score = fuzzyScore(text(item), trimmed);
    if (score !== null) scored.push({ item, score });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit).map((entry) => entry.item);
}
