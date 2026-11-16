import type { DropEdge } from '#lib/ui/drag-list.js';

export { reorderChildren, sortEdges } from '#lib/model/model.js';
export type { ChildOrder as Reorder } from '#src/generated/protocol';

export function dropIndex(from: number, target: number, position: DropEdge): number {
  const insertAt = position === 'below' ? target + 1 : target;

  return insertAt > from ? insertAt - 1 : insertAt;
}
