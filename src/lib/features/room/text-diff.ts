export interface DiffSegment {
  kind: 'same' | 'added' | 'removed';
  text: string;
}

const MAX_CELLS = 250_000;

function tokens(text: string): string[] {
  return text.split(/(\s+)/u).filter((token) => token !== '');
}

function push(segments: DiffSegment[], kind: DiffSegment['kind'], text: string): void {
  const last = segments.at(-1);
  if (last?.kind === kind) last.text += text;
  else segments.push({ kind, text });
}

export function diffWords(before: string, after: string): DiffSegment[] {
  const left = tokens(before);
  const right = tokens(after);
  if (left.length * right.length > MAX_CELLS) {
    const segments: DiffSegment[] = [];
    if (before) segments.push({ kind: 'removed', text: before });
    if (after) segments.push({ kind: 'added', text: after });
    return segments;
  }

  const width = right.length + 1;
  const lengths = new Uint32Array((left.length + 1) * width);
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      lengths[i * width + j] =
        left[i] === right[j]
          ? lengths[(i + 1) * width + j + 1] + 1
          : Math.max(lengths[(i + 1) * width + j], lengths[i * width + j + 1]);
    }
  }

  const segments: DiffSegment[] = [];
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      push(segments, 'same', left[i]);
      i += 1;
      j += 1;
    } else if (lengths[(i + 1) * width + j] >= lengths[i * width + j + 1]) {
      push(segments, 'removed', left[i]);
      i += 1;
    } else {
      push(segments, 'added', right[j]);
      j += 1;
    }
  }
  for (; i < left.length; i += 1) push(segments, 'removed', left[i]);
  for (; j < right.length; j += 1) push(segments, 'added', right[j]);
  return segments;
}
