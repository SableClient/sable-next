import { describe, expect, it } from 'vitest';

import { applyDiffs } from './index';

describe('applyDiffs', () => {
  it('applies a mixed pagination batch without changing the current timeline', () => {
    const current = ['newer-a', 'newer-b'];

    const next = applyDiffs(current, [
      { op: 'push_front', value: 'older-b' },
      { op: 'push_front', value: 'older-a' },
      { op: 'append', values: ['newer-c'] },
      { op: 'set', index: 3, value: 'newer-c-updated' },
    ]);

    expect(next).toEqual(['older-a', 'older-b', 'newer-a', 'newer-c-updated', 'newer-c']);
    expect(current).toEqual(['newer-a', 'newer-b']);
  });

  it.each([
    ['append', ['a', 'b'], [{ op: 'append', values: ['c', 'd'] }], ['a', 'b', 'c', 'd']],
    ['clear', ['a', 'b'], [{ op: 'clear' }], []],
    ['push_front', ['b'], [{ op: 'push_front', value: 'a' }], ['a', 'b']],
    ['push_back', ['a'], [{ op: 'push_back', value: 'b' }], ['a', 'b']],
    ['pop_front', ['a', 'b'], [{ op: 'pop_front' }], ['b']],
    ['pop_back', ['a', 'b'], [{ op: 'pop_back' }], ['a']],
    ['insert', ['a', 'c'], [{ op: 'insert', index: 1, value: 'b' }], ['a', 'b', 'c']],
    ['set', ['a', 'b'], [{ op: 'set', index: 1, value: 'c' }], ['a', 'c']],
    ['remove', ['a', 'b', 'c'], [{ op: 'remove', index: 1 }], ['a', 'c']],
    ['truncate', ['a', 'b', 'c'], [{ op: 'truncate', length: 2 }], ['a', 'b']],
    ['reset', ['a', 'b'], [{ op: 'reset', values: ['c', 'd'] }], ['c', 'd']],
  ] as const)('applies %s', (_operation, current, diffs, expected) => {
    const original = [...current];

    expect(applyDiffs(current, diffs)).toEqual(expected);
    expect(current).toEqual(original);
  });
});
