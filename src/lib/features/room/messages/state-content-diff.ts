import { diffArrays } from 'diff';

import { isRecord } from '#lib/guards.js';

export interface StateContentChange {
  path: readonly string[];
  before: unknown;
  after: unknown;
}

function same(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function walkArray(
  before: unknown[],
  after: unknown[],
  path: readonly string[],
  changes: StateContentChange[]
): void {
  let index = 0;
  for (const change of diffArrays(before, after, { comparator: same })) {
    if (change.removed) {
      for (const [offset, value] of change.value.entries()) {
        changes.push({ path: [...path, String(index + offset)], before: value, after: undefined });
      }
      continue;
    }
    if (change.added) {
      for (const [offset, value] of change.value.entries()) {
        changes.push({ path: [...path, String(index + offset)], before: undefined, after: value });
      }
    }
    index += change.value.length;
  }
}

function walk(
  before: unknown,
  after: unknown,
  path: readonly string[],
  changes: StateContentChange[]
): void {
  if (Array.isArray(before) && Array.isArray(after)) {
    walkArray(before, after, path, changes);
    return;
  }
  if (Array.isArray(before) && after === undefined) {
    walkArray(before, [], path, changes);
    return;
  }
  if (before === undefined && Array.isArray(after)) {
    walkArray([], after, path, changes);
    return;
  }
  if (isRecord(before) && isRecord(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of keys) walk(before[key], after[key], [...path, key], changes);
    return;
  }
  if (same(before, after)) return;
  if (isRecord(before) && after === undefined) {
    for (const key of Object.keys(before)) walk(before[key], undefined, [...path, key], changes);
    return;
  }
  if (before === undefined && isRecord(after)) {
    for (const key of Object.keys(after)) walk(undefined, after[key], [...path, key], changes);
    return;
  }
  changes.push({ path, before, after });
}

export function stateContentDiff(before: unknown, after: unknown): StateContentChange[] {
  const changes: StateContentChange[] = [];
  walk(isRecord(before) ? before : {}, isRecord(after) ? after : {}, [], changes);
  return changes;
}

export function stateValueText(value: unknown): string {
  return value === undefined ? String(value) : JSON.stringify(value);
}
