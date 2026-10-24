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

function targetPath(
  state: Record<string, unknown>,
  field: string
): [Record<string, unknown>, string] {
  const parts = field.split('.');
  const leaf = parts.pop();
  if (leaf === undefined) throw new PatchError(field);
  let current = state;
  for (const part of parts) {
    const next = current[part];
    if (typeof next !== 'object' || next === null || Array.isArray(next)) {
      throw new PatchError(field);
    }
    current = next as Record<string, unknown>;
  }
  return [current, leaf];
}

function withPath(
  state: Record<string, unknown>,
  field: string,
  value: unknown
): Record<string, unknown> {
  const parts = field.split('.');
  const leaf = parts.pop();
  if (leaf === undefined) throw new PatchError(field);
  const output = { ...state };
  let source = state;
  let target = output;
  for (const part of parts) {
    const child = source[part];
    if (typeof child !== 'object' || child === null || Array.isArray(child)) {
      throw new PatchError(field);
    }
    const copy = { ...(child as Record<string, unknown>) };
    target[part] = copy;
    source = child as Record<string, unknown>;
    target = copy;
  }
  target[leaf] = value;
  return output;
}

/** Untouched fields keep their identity; throws when a list diff does not fit. */
export function applyOps(state: unknown, ops: readonly Op[]): unknown {
  let current = state;
  for (const op of ops) {
    if (op.op === 'fields') {
      if (typeof current !== 'object' || current === null || Array.isArray(current)) {
        throw new PatchError('');
      }
      current = { ...(current as Record<string, unknown>) };
      for (const [field, value] of Object.entries(op.fields)) {
        current = withPath(current as Record<string, unknown>, field, value);
      }
      continue;
    }
    if (typeof current !== 'object' || current === null || Array.isArray(current)) {
      throw new PatchError(op.field);
    }
    const [parent, leaf] = targetPath(current as Record<string, unknown>, op.field);
    const list = parent[leaf];
    if (!Array.isArray(list)) throw new PatchError(op.field);
    current = withPath(
      current as Record<string, unknown>,
      op.field,
      applyDiffs(list, op.diffs, op.field)
    );
  }
  return current;
}
