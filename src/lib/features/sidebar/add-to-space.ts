import type { RoomSummary } from '#src/generated/RoomSummary';

export function wouldCreateCycle(
  rooms: readonly RoomSummary[],
  targetSpaceId: string,
  memberId: string
): boolean {
  if (targetSpaceId === memberId) return true;

  const byId = new Map(rooms.map((candidate) => [candidate.room_id, candidate]));
  const visited = new Set<string>();
  const stack = [memberId];

  while (stack.length > 0) {
    const current = stack.pop();
    if (current === undefined || visited.has(current)) continue;
    visited.add(current);

    for (const edge of byId.get(current)?.space_children ?? []) {
      if (edge.room_id === targetSpaceId) return true;
      stack.push(edge.room_id);
    }
  }

  return false;
}
