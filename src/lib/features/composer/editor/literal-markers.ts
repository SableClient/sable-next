const OPENING_PREFIX = '([{<"\'*_~|';

function isSpace(char: string | undefined): boolean {
  return char !== undefined && /\s/u.test(char);
}

function runLength(text: string, index: number): number {
  let end = index;
  while (text.at(end) === text.at(index)) end++;
  return end - index;
}

function markerEnd(text: string, index: number): number | null {
  const first = text[index];
  const run = runLength(text, index);
  const valid =
    first === '*' || first === '_' ? run <= 2 : (first === '~' || first === '|') && run === 2;
  if (!valid) return null;
  const before = index > 0 ? text.at(index - 1) : undefined;
  if (before !== undefined && !isSpace(before) && !OPENING_PREFIX.includes(before)) return null;
  const next = text.at(index + run);
  if (next === undefined || isSpace(next) || next === first) return null;

  let previous: string | undefined;
  for (let at = index + run; at < text.length; at++) {
    const char = text[at];
    if (char === '\\') {
      previous = char;
      at++;
      continue;
    }
    if (char === first) {
      const length = runLength(text, at);
      const after = text.at(at + length);
      if (
        length === run &&
        previous !== undefined &&
        !isSpace(previous) &&
        (first !== '_' || after === undefined || !/[\p{L}\p{N}]/u.test(after))
      ) {
        return at + length;
      }
      at += length - 1;
      previous = first;
      continue;
    }
    previous = char;
  }
  return null;
}

function codeEnd(text: string, index: number, ticks: number): number | null {
  for (let at = index + ticks; at < text.length; at++) {
    if (text[at] !== '`') continue;
    const length = runLength(text, at);
    if (length === ticks) return at > index + ticks ? at + length : null;
    at += length - 1;
  }
  return null;
}

/** Offsets of the opening delimiters the receiver would turn into formatting. */
export function markerOpeners(text: string): number[] {
  const openers: number[] = [];
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === '\\') {
      index += 2;
      continue;
    }
    if (char === '`') {
      const ticks = runLength(text, index);
      const end = codeEnd(text, index, ticks);
      if (end === null) return openers;
      openers.push(index);
      index = end;
      continue;
    }
    if (char === '*' || char === '_' || char === '~' || char === '|') {
      const end = markerEnd(text, index);
      if (end !== null) {
        openers.push(index);
        index = end;
        continue;
      }
      index += runLength(text, index);
      continue;
    }
    index += 1;
  }
  return openers;
}

/** Splits `text` so that no piece contains a delimiter pair the receiver would format. */
export function literalPieces(text: string): string[] {
  const cuts = new Set<number>();
  for (;;) {
    const points = [0, ...[...cuts].sort((a, b) => a - b), text.length];
    let added = false;
    for (let i = 0; i + 1 < points.length; i++) {
      const start = points[i] + (i === 0 ? 0 : 1);
      const end = points[i + 1];
      if (start >= end) continue;
      const opener = markerOpeners(text.slice(start, end)).at(0);
      if (opener !== undefined) {
        cuts.add(start + opener);
        added = true;
        break;
      }
    }
    if (!added) break;
  }
  return cuts.size === 0 ? [text] : splitAt(text, cuts);
}

function splitAt(text: string, cuts: Set<number>): string[] {
  const pieces: string[] = [];
  let start = 0;
  for (const cut of [...cuts].sort((a, b) => a - b)) {
    pieces.push(text.slice(start, cut), text.slice(cut, cut + 1));
    start = cut + 1;
  }
  pieces.push(text.slice(start));
  return pieces;
}
