import { expect, test } from 'vitest';

import { literalPieces, markerOpeners } from './literal-markers';

test.each([
  ['a **b** c', [2]],
  ['*a* and _b_ and ~~c~~ and ||d||', [0, 8, 16, 26]],
  ['`code` next', [0]],
  ['**a _b_ c**', [0]],
])('%j has openers at %j', (text, openers) => {
  expect(markerOpeners(text)).toEqual(openers);
});

test.each([
  '2 * 3 * 4',
  'snake_case_name',
  'a*b*c',
  'https://example.org/_a_/*b*',
  'a || b || c',
  '\\*like so\\*',
  'lonely *star',
  '***x***',
  'unclosed `tick **x**',
])('%j has no openers', (text) => {
  expect(markerOpeners(text)).toEqual([]);
});

test('a pair is split so the receiver cannot match it', () => {
  expect(literalPieces('say **hi** now')).toEqual(['say ', '*', '*hi** now']);
  expect(literalPieces('plain')).toEqual(['plain']);
});

test.each(['*a **b** c*', '||x *y* z||', '**a** and *b* and `c`', '_a_ _b_', '~~~~a~~~~ **'])(
  'splitting %j leaves nothing to format',
  (text) => {
    const pieces = literalPieces(text);
    expect(pieces.join('')).toBe(text);
    pieces.forEach((piece, index) => {
      if (index % 2 === 0) expect(markerOpeners(piece)).toEqual([]);
    });
  }
);
