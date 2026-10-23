import { describe, expect, it } from 'vitest';
import type { VectorDiffWire } from '#src/generated/protocol';

import { applyDiffs } from './index';

describe('applyDiffs', () => {
  it('applies a mixed pagination batch without changing the current timeline', () => {
    const current = ['newer-a', 'newer-b'];

    const next = applyDiffs(current, [
      { PushFront: { value: 'older-b' } },
      { PushFront: { value: 'older-a' } },
      { Append: { values: ['newer-c'] } },
      { Set: { index: 3, value: 'newer-c-updated' } },
    ]);

    expect(next).toEqual(['older-a', 'older-b', 'newer-a', 'newer-c-updated', 'newer-c']);
    expect(current).toEqual(['newer-a', 'newer-b']);
  });

  it.each<[string, string[], VectorDiffWire<string>[], string[]]>([
    ['append', ['a', 'b'], [{ Append: { values: ['c', 'd'] } }], ['a', 'b', 'c', 'd']],
    ['clear', ['a', 'b'], [{ Clear: {} }], []],
    ['push_front', ['b'], [{ PushFront: { value: 'a' } }], ['a', 'b']],
    ['push_back', ['a'], [{ PushBack: { value: 'b' } }], ['a', 'b']],
    ['pop_front', ['a', 'b'], [{ PopFront: {} }], ['b']],
    ['pop_back', ['a', 'b'], [{ PopBack: {} }], ['a']],
    ['insert', ['a', 'c'], [{ Insert: { index: 1, value: 'b' } }], ['a', 'b', 'c']],
    ['set', ['a', 'b'], [{ Set: { index: 1, value: 'c' } }], ['a', 'c']],
    ['remove', ['a', 'b', 'c'], [{ Remove: { index: 1 } }], ['a', 'c']],
    ['truncate', ['a', 'b', 'c'], [{ Truncate: { length: 2 } }], ['a', 'b']],
    ['reset', ['a', 'b'], [{ Reset: { values: ['c', 'd'] } }], ['c', 'd']],
  ])('applies %s', (_operation, current, diffs, expected) => {
    const original = [...current];

    expect(applyDiffs(current, diffs)).toEqual(expected);
    expect(current).toEqual(original);
  });
});
