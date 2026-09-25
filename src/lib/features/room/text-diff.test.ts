import { expect, test } from 'vitest';

import { diffWords } from './text-diff';

test('marks the words an edit removed and added', () => {
  expect(diffWords('the quick fox', 'the slow fox')).toEqual([
    { kind: 'same', text: 'the ' },
    { kind: 'removed', text: 'quick' },
    { kind: 'added', text: 'slow' },
    { kind: 'same', text: ' fox' },
  ]);
});

test('an appended sentence is one added segment', () => {
  expect(diffWords('hello', 'hello there')).toEqual([
    { kind: 'same', text: 'hello' },
    { kind: 'added', text: ' there' },
  ]);
});

test('identical text has nothing but a same segment', () => {
  expect(diffWords('same', 'same')).toEqual([{ kind: 'same', text: 'same' }]);
  expect(diffWords('', '')).toEqual([]);
});

test('a body too long to align falls back to a whole replacement', () => {
  const before = Array.from({ length: 600 }, (_, index) => `a${String(index)}`).join(' ');
  const after = Array.from({ length: 600 }, (_, index) => `b${String(index)}`).join(' ');
  expect(diffWords(before, after)).toEqual([
    { kind: 'removed', text: before },
    { kind: 'added', text: after },
  ]);
});
