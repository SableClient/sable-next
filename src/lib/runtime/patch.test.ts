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

  it('applies the fixture document patch, replacing and removing keys', () => {
    const state = { names: { bob: 'Bob', cy: 'Cy' }, other: { n: 1 } };
    const next = applyOps(state, opsOf(forms.document_patch)) as typeof state;
    expect(next.names).toEqual({ ann: 'Ann', cy: 'Cy' });
    expect(next.other).toBe(state.other);
  });

  it('keeps the identity of what an op leaves alone', () => {
    const state = { a: { x: [1] }, b: { y: [2] } };
    const next = applyOps(state, [{ op: 'replace', path: '/a/x', value: [3] }]) as typeof state;
    expect(next).not.toBe(state);
    expect(next.b).toBe(state.b);
  });

  it('replaces the whole state at the empty path', () => {
    expect(applyOps({ a: 1 }, [{ op: 'replace', path: '', value: 7 }])).toBe(7);
  });

  it('unescapes slashes and tildes in keys', () => {
    expect(applyOps({}, [{ op: 'replace', path: '/a~1b~0c', value: 1 }])).toEqual({ 'a/b~c': 1 });
  });

  it('does not let a key named __proto__ reach the prototype', () => {
    const next = applyOps({}, [{ op: 'replace', path: '/__proto__', value: { x: 1 } }]);
    expect(Object.getPrototypeOf(next)).toBe(Object.prototype);
    expect(Object.hasOwn(next as object, '__proto__')).toBe(true);
  });

  it('edits a list inside the state with every diff form', () => {
    const state = { items: [1, 2, 3, 4] };
    const next = applyOps(state, [
      {
        op: 'list',
        path: '/items',
        diffs: [
          { op: 'push_front', value: 0 },
          { op: 'pop_back' },
          { op: 'insert', index: 1, value: 9 },
          { op: 'set', index: 0, value: 5 },
          { op: 'remove', index: 2 },
          { op: 'truncate', length: 3 },
          { op: 'append', values: [7, 8] },
        ],
      },
    ]);
    expect(next).toEqual({ items: [5, 9, 2, 7, 8] });
    expect(state.items).toEqual([1, 2, 3, 4]);
  });

  it('resets a list', () => {
    const next = applyOps({ items: [1] }, [
      { op: 'list', path: '/items', diffs: [{ op: 'reset', values: [4, 5] }] },
    ]);
    expect(next).toEqual({ items: [4, 5] });
  });

  it.each<[string, Op]>([
    ['a path that is missing', { op: 'replace', path: '/x/b', value: 1 }],
    ['a remove of a missing key', { op: 'remove', path: '/nope' }],
    ['a list op on an object', { op: 'list', path: '/a', diffs: [] }],
    ['an index past the end', { op: 'list', path: '/l', diffs: [{ op: 'remove', index: 3 }] }],
  ])('throws on %s', (_, op) => {
    expect(() => applyOps({ a: {}, l: [1] }, [op])).toThrow(PatchError);
  });
});
