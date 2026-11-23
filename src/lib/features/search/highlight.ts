import escapeStringRegexp from 'escape-string-regexp';

import { UNSPACED } from './query-words';

export interface Segment {
  text: string;
  match: boolean;
}

export interface Snippet {
  segments: Segment[];
  clippedStart: boolean;
  clippedEnd: boolean;
}

const WINDOW_RADIUS = 90;
const SPACED_LETTER = `(?!${UNSPACED.source})[\\p{L}\\p{N}]`;

type Range = [number, number];

function phraseRanges(body: string, phrase: string, whole = false): Range[] {
  const escaped = escapeStringRegexp(phrase.trim());
  if (escaped === '') return [];

  const source = escaped.replace(/\s+/g, '\\s+');
  const pattern = new RegExp(
    whole ? `(?<!${SPACED_LETTER})${source}(?!${SPACED_LETTER})` : source,
    'giu'
  );
  return [...body.matchAll(pattern)].map((match) => [match.index, match.index + match[0].length]);
}

function matchRanges(body: string, terms: readonly string[]): Range[] {
  const words = terms.filter(
    (term) => term.trim() !== '' && !/\s/.test(term.trim()) && !UNSPACED.test(term)
  );
  const phrases = terms.filter((term) => /\s/.test(term.trim()) || UNSPACED.test(term));
  const ranges = [
    ...phrases.flatMap((phrase) => phraseRanges(body, phrase)),
    ...words.flatMap((word) => phraseRanges(body, word, true)),
  ];

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
