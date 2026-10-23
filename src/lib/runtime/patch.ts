import type { Op, VectorDiffWire } from '#src/generated/protocol';

export class PatchError extends Error {
  constructor(field: string) {
    super(`The patch does not fit the state at field "${field}"`);
    this.name = 'PatchError';
  }
}

function applyDiffs(list: readonly unknown[], diffs: VectorDiffWire<unknown>[], field: string) {
  const items = list.slice();
  for (const diff of diffs) {
    if ('Clear' in diff) items.length = 0;
    else if ('PopFront' in diff) items.shift();
    else if ('PopBack' in diff) items.pop();
    else if ('Append' in diff && diff.Append) items.push(...diff.Append.values);
    else if ('PushFront' in diff && diff.PushFront) items.unshift(diff.PushFront.value);
    else if ('PushBack' in diff && diff.PushBack) items.push(diff.PushBack.value);
    else if ('Insert' in diff && diff.Insert) {
      if (diff.Insert.index > items.length) throw new PatchError(field);
      items.splice(diff.Insert.index, 0, diff.Insert.value);
    } else if ('Set' in diff && diff.Set) {
      if (diff.Set.index >= items.length) throw new PatchError(field);
      items[diff.Set.index] = diff.Set.value;
    } else if ('Remove' in diff && diff.Remove) {
      if (diff.Remove.index >= items.length) throw new PatchError(field);
      items.splice(diff.Remove.index, 1);
    } else if ('Truncate' in diff && diff.Truncate) {
      items.length = Math.min(items.length, diff.Truncate.length);
    } else if ('Reset' in diff) items.splice(0, items.length, ...diff.Reset.values);
  }
  return items;
}

/** Untouched fields keep their identity; throws when a list diff does not fit. */
export function applyOps(state: unknown, ops: readonly Op[]): unknown {
  let current = state;
  for (const op of ops) {
    if (op.op === 'fields') {
      if (typeof current !== 'object' || current === null || Array.isArray(current)) {
        throw new PatchError('');
      }
      current = { ...(current as Record<string, unknown>), ...op.fields };
      continue;
    }
    if (typeof current !== 'object' || current === null || Array.isArray(current)) {
      throw new PatchError(op.field);
    }
    const list = (current as Record<string, unknown>)[op.field];
    if (!Array.isArray(list)) throw new PatchError(op.field);
    current = {
      ...(current as Record<string, unknown>),
      [op.field]: applyDiffs(list, op.diffs, op.field),
    };
  }
  return current;
}
