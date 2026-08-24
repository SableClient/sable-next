import type { DropEdge } from '#lib/ui/drag-list.js';

const FIRST = 0x20;
const LAST = 0x7e;
const MAX_LENGTH = 50;

function codes(order: string): number[] {
  return Array.from({ length: order.length }, (_, index) => order.charCodeAt(index));
}

function fromCodes(values: readonly number[]): string {
  return values.map((value) => String.fromCharCode(value)).join('');
}

function at(values: readonly number[], index: number, fallback: number): number {
  return values[index] ?? fallback;
}

export function orderBetween(before: string | null, after: string | null): string | null {
  const low = before === null ? [] : codes(before);
  const high = after === null ? [] : codes(after);
  const result: number[] = [];

  for (let index = 0; index < MAX_LENGTH; index += 1) {
    const lower = at(low, index, FIRST - 1);
    const upper = at(high, index, LAST + 1);

    if (upper - lower > 1) {
      result.push(Math.floor((lower + upper) / 2));
      return fromCodes(result);
    }

    result.push(Math.max(lower, FIRST));
  }

  return null;
}

export function orderKeys(desired: readonly (string | null)[]): (string | null)[] {
  const keys: (string | null)[] = [];
  let previous: string | null = null;

  for (const [index, current] of desired.entries()) {
    const trailingUnordered = desired.slice(index).every((entry) => entry === null);
    if (current === null && trailingUnordered && previous === null) {
      keys.push(null);
      continue;
    }

    if (current !== null && (previous === null || previous < current)) {
      keys.push(current);
      previous = current;
      continue;
    }

    const nextFixed =
      desired.slice(index + 1).find((entry) => entry !== null && entry > (previous ?? '')) ?? null;
    const generated = orderBetween(previous, nextFixed);
    if (generated === null) return renumber(desired.length);

    keys.push(generated);
    previous = generated;
  }

  return keys;
}

function renumber(count: number): string[] {
  const span = LAST - FIRST + 1;
  const width = Math.max(1, Math.ceil(Math.log(Math.max(count, 1)) / Math.log(span)) + 1);
  const step = Math.floor(span ** width / (count + 1));

  return Array.from({ length: count }, (_, index) => {
    let value = step * (index + 1);
    const digits: number[] = [];
    for (let place = 0; place < width; place += 1) {
      digits.unshift(FIRST + (value % span));
      value = Math.floor(value / span);
    }
    return fromCodes(digits);
  });
}

export interface Reorder {
  roomId: string;
  order: string | null;
}

function fullyOrdered(orders: readonly (string | null)[]): boolean {
  return orders.every(
    (order, index) => order !== null && (index === 0 || (orders[index - 1] ?? '') < order)
  );
}

export function reorderChildren(
  children: readonly { roomId: string; order: string | null }[],
  roomId: string,
  targetIndex: number
): Reorder[] {
  const from = children.findIndex((child) => child.roomId === roomId);
  if (from === -1) return [];

  const moved = [...children];
  const [entry] = moved.splice(from, 1);
  const to = Math.max(0, Math.min(targetIndex, moved.length));
  moved.splice(to, 0, entry);
  if (to === from) return [];

  const others = moved.filter((child) => child.roomId !== roomId).map((child) => child.order);

  if (fullyOrdered(others)) {
    const generated = orderBetween(moved[to - 1]?.order ?? null, moved[to + 1]?.order ?? null);
    if (generated !== null) return [{ roomId, order: generated }];
  }

  const keys = renumber(moved.length);
  return moved
    .map((child, index) => ({ roomId: child.roomId, order: keys[index] ?? null }))
    .filter((next, index) => next.order !== moved[index]?.order);
}

export function dropIndex(from: number, target: number, position: DropEdge): number {
  const insertAt = position === 'below' ? target + 1 : target;

  return insertAt > from ? insertAt - 1 : insertAt;
}

export function sortEdges<T extends { order: string | null; origin_server_ts: number }>(
  edges: readonly T[]
): T[] {
  return [...edges].sort((left, right) => {
    if (left.order !== null && right.order !== null) {
      if (left.order !== right.order) return left.order < right.order ? -1 : 1;
    } else if (left.order !== null) {
      return -1;
    } else if (right.order !== null) {
      return 1;
    }

    return left.origin_server_ts - right.origin_server_ts;
  });
}
