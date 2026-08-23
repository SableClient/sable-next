export interface Segment {
  text: string;
  match: boolean;
}

export interface Snippet {
  segments: Segment[];
  clippedStart: boolean;
  clippedEnd: boolean;
}

const MIN_STEM_OVERLAP = 4;
const MIN_STEM_RATIO = [3, 5];
const WINDOW_RADIUS = 90;
const WORD = /[\p{L}\p{N}]+/gu;

type Range = [number, number];

function sharesStem(word: string, term: string): boolean {
  const left = word.toLocaleLowerCase();
  const right = term.toLocaleLowerCase();
  if (left === right) return true;

  const shorter = left.length < right.length ? left : right;
  const longer = left.length < right.length ? right : left;
  const [low, high] = MIN_STEM_RATIO;

  return (
    shorter.length >= MIN_STEM_OVERLAP &&
    shorter.length * high >= longer.length * low &&
    longer.startsWith(shorter)
  );
}

function phraseRanges(body: string, phrase: string): Range[] {
  const escaped = phrase.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (escaped === '') return [];

  const pattern = new RegExp(escaped.replace(/\s+/g, '\\s+'), 'giu');
  return [...body.matchAll(pattern)].map((match) => [match.index, match.index + match[0].length]);
}

function matchRanges(body: string, terms: readonly string[]): Range[] {
  const words = terms.filter((term) => term.trim() !== '' && !/\s/.test(term.trim()));
  const phrases = terms.filter((term) => /\s/.test(term.trim()));
  const ranges = phrases.flatMap((phrase) => phraseRanges(body, phrase));

  for (const match of body.matchAll(WORD)) {
    if (words.some((term) => sharesStem(match[0], term))) {
      ranges.push([match.index, match.index + match[0].length]);
    }
  }

  ranges.sort((left, right) => left[0] - right[0] || left[1] - right[1]);

  const merged: Range[] = [];
  for (const [start, end] of ranges) {
    const last = merged.at(-1);
    if (last && start <= last[1]) last[1] = Math.max(last[1], end);
    else merged.push([start, end]);
  }

  return merged;
}

export function highlightSegments(body: string, terms: readonly string[]): Segment[] {
  const ranges = matchRanges(body, terms);
  if (ranges.length === 0) return [{ text: body, match: false }];

  const segments: Segment[] = [];
  let cursor = 0;

  for (const [start, end] of ranges) {
    if (start > cursor) segments.push({ text: body.slice(cursor, start), match: false });
    segments.push({ text: body.slice(start, end), match: true });
    cursor = end;
  }

  if (cursor < body.length) segments.push({ text: body.slice(cursor), match: false });
  return segments;
}

export function snippetAround(body: string, terms: readonly string[]): Snippet {
  const segments = highlightSegments(body, terms);
  if (body.length <= WINDOW_RADIUS * 2) {
    return { segments, clippedStart: false, clippedEnd: false };
  }

  const firstMatch = segments.findIndex((segment) => segment.match);
  let offset = 0;
  for (const segment of segments.slice(0, Math.max(firstMatch, 0))) offset += segment.text.length;

  const from = Math.max(0, offset - WINDOW_RADIUS);
  const to = Math.min(body.length, offset + WINDOW_RADIUS);

  return {
    segments: clip(segments, from, to),
    clippedStart: from > 0,
    clippedEnd: to < body.length,
  };
}

function clip(segments: readonly Segment[], from: number, to: number): Segment[] {
  const clipped: Segment[] = [];
  let position = 0;

  for (const segment of segments) {
    const start = position;
    const end = position + segment.text.length;
    position = end;

    if (end <= from || start >= to) continue;
    const text = segment.text.slice(
      Math.max(0, from - start),
      Math.min(segment.text.length, to - start)
    );
    if (text !== '') clipped.push({ text, match: segment.match });
  }

  return clipped;
}
