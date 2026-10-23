import type { Op, VectorDiff } from '#src/generated/protocol';

export class PatchError extends Error {
  constructor(path: string) {
    super(`The patch does not fit the state at "${path}"`);
    this.name = 'PatchError';
  }
}

function keys(path: string): string[] {
  if (path === '') return [];
  return path
    .split('/')
    .slice(1)
    .map((key) => key.replaceAll('~1', '/').replaceAll('~0', '~'));
}

function child(node: unknown, key: string, path: string): unknown {
  if (Array.isArray(node) && /^\d+$/.test(key) && Number(key) < node.length) {
    return node[Number(key)];
  }
  if (
    typeof node === 'object' &&
    node !== null &&
    !Array.isArray(node) &&
    Object.hasOwn(node, key)
  ) {
    return (node as Record<string, unknown>)[key];
  }
  throw new PatchError(path);
}

function withChild(node: unknown, key: string, next: unknown): unknown {
  if (Array.isArray(node)) {
    const copy = node.slice();
    copy[Number(key)] = next;
    return copy;
  }
  return { ...(node as Record<string, unknown>), [key]: next };
}

function editAt(
  node: unknown,
  path: string[],
  from: number,
  whole: string,
  edit: (node: unknown) => unknown
): unknown {
  if (from === path.length) return edit(node);
  const key = path[from];
  const before = child(node, key, whole);
  const after = editAt(before, path, from + 1, whole, edit);
  return after === before ? node : withChild(node, key, after);
}

function isObject(node: unknown): node is Record<string, unknown> {
  return typeof node === 'object' && node !== null && !Array.isArray(node);
}

function applyDiffs(list: readonly unknown[], diffs: VectorDiff<unknown>[], path: string) {
  const items = list.slice();
  for (const diff of diffs) {
    switch (diff.op) {
      case 'append':
        items.push(...diff.values);
        break;
      case 'clear':
        items.length = 0;
        break;
      case 'push_front':
        items.unshift(diff.value);
        break;
      case 'push_back':
        items.push(diff.value);
        break;
      case 'pop_front':
        items.shift();
        break;
      case 'pop_back':
        items.pop();
        break;
      case 'insert':
        if (diff.index > items.length) throw new PatchError(path);
        items.splice(diff.index, 0, diff.value);
        break;
      case 'set':
        if (diff.index >= items.length) throw new PatchError(path);
        items[diff.index] = diff.value;
        break;
      case 'remove':
        if (diff.index >= items.length) throw new PatchError(path);
        items.splice(diff.index, 1);
        break;
      case 'truncate':
        items.length = Math.min(items.length, diff.length);
        break;
      case 'reset':
        items.splice(0, items.length, ...diff.values);
        break;
    }
  }
  return items;
}

/**
 * Untouched subtrees keep their identity, so a subscriber can compare by reference.
 * @throws {PatchError} when an op does not fit the state.
 */
export function applyOps(state: unknown, ops: readonly Op[]): unknown {
  return ops.reduce((current, op) => applyOp(current, op), state);
}

function applyOp(state: unknown, op: Op): unknown {
  const path = keys(op.path);
  switch (op.op) {
    case 'replace': {
      const key = path.pop();
      if (key === undefined) return op.value;
      return editAt(state, path, 0, op.path, (parent) => {
        if (!isObject(parent)) throw new PatchError(op.path);
        return withChild(parent, key, op.value);
      });
    }
    case 'remove': {
      const key = path.pop();
      if (key === undefined) throw new PatchError(op.path);
      return editAt(state, path, 0, op.path, (parent) => {
        if (!isObject(parent) || !Object.hasOwn(parent, key)) throw new PatchError(op.path);
        return Object.fromEntries(Object.entries(parent).filter(([name]) => name !== key));
      });
    }
    case 'list':
      return editAt(state, path, 0, op.path, (list) => {
        if (!Array.isArray(list)) throw new PatchError(op.path);
        return applyDiffs(list, op.diffs, op.path);
      });
  }
}
