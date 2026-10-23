import { describe, expect, it } from 'vitest';

import type { Batch, Op } from '#src/generated/protocol';
import forms from '../../../tests/fixtures/wire/forms.json';
import { applyOps, PatchError } from './patch';

const opsOf = (batch: unknown): Op[] =>
  (batch as Batch).events.flatMap((event) => (event.type === 'patch' ? event.ops : []));

describe('applyOps', () => {
  it('applies the fixture patch to the fixture snapshot', () => {
    const next = applyOps(forms.subscribed.snapshot.state, opsOf(forms.patch));
    expect(next).toEqual({ total: 3, items: ['a', 'b', 'c'] });
  });

  it('applies changed fields without touching unrelated identity', () => {
    const other = { n: 1 };
    const state = { names: { bob: 'Bob', cy: 'Cy' }, other };
    const next = applyOps(state, [
      { op: 'fields', fields: { names: { ann: 'Ann', cy: 'Cy' } } },
    ]) as typeof state;
    expect(next.names).toEqual({ ann: 'Ann', cy: 'Cy' });
    expect(next.other).toBe(other);
  });

  it('keeps the identity of fields untouched by a list diff', () => {
    const names = { bob: 'Bob' };
    const state = { items: [1, 2, 3], names };
    const next = applyOps(state, [
      { op: 'list', field: 'items', diffs: [{ Set: { index: 1, value: 7 } }] },
    ]) as typeof state;
    expect(next.items).toEqual([1, 7, 3]);
    expect(next.names).toBe(names);
  });

  it('edits a list with every diff form', () => {
    const state = { items: [1, 2, 3, 4] };
    const next = applyOps(state, [
      {
        op: 'list',
        field: 'items',
        diffs: [
          { PushFront: { value: 0 } },
          { PopBack: {} },
          { Insert: { index: 1, value: 9 } },
          { Set: { index: 0, value: 5 } },
          { Remove: { index: 2 } },
          { Truncate: { length: 3 } },
          { Append: { values: [7, 8] } },
        ],
      },
    ]);
    expect(next).toEqual({ items: [5, 9, 2, 7, 8] });
    expect(state.items).toEqual([1, 2, 3, 4]);
  });

  it('resets a list', () => {
    const next = applyOps({ items: [1] }, [
      { op: 'list', field: 'items', diffs: [{ Reset: { values: [4, 5] } }] },
    ]);
    expect(next).toEqual({ items: [4, 5] });
  });

  it.each<[string, Op]>([
    ['a list op on an object', { op: 'list', field: 'a', diffs: [] }],
    ['a missing list field', { op: 'list', field: 'nope', diffs: [] }],
    ['an index past the end', { op: 'list', field: 'l', diffs: [{ Remove: { index: 3 } }] }],
  ])('throws on %s', (_, op) => {
    expect(() => applyOps({ a: {}, l: [1] }, [op])).toThrow(PatchError);
  });
});
