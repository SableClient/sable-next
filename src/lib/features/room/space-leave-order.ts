import type { RoomSummary } from '#src/generated/RoomSummary';

export type SpaceChildrenLeaveOrder = {
  order: string[];
  roomCount: number;
  subspaceCount: number;
};

function isJoinedLive(room: RoomSummary | undefined): room is RoomSummary {
  return room !== undefined && room.state === 'joined' && !room.is_tombstoned;
}

export function joinedSpaceChildrenLeaveOrder(
  rooms: readonly RoomSummary[],
  rootSpaceId: string
): SpaceChildrenLeaveOrder {
  const byId = new Map(rooms.map((candidate) => [candidate.room_id, candidate]));
  const order: string[] = [];
  const visited = new Set<string>();
  let roomCount = 0;
  let subspaceCount = 0;

  function visitSpace(spaceId: string): void {
    if (visited.has(spaceId)) return;
    visited.add(spaceId);

    const space = byId.get(spaceId);
    if (!isJoinedLive(space)) return;

    for (const edge of space.space_children) {
      if (visited.has(edge.room_id)) continue;

      const child = byId.get(edge.room_id);
      if (!isJoinedLive(child)) continue;

      if (child.is_space) {
        visitSpace(child.room_id);
        continue;
      }

      visited.add(child.room_id);
      order.push(child.room_id);
      roomCount += 1;
    }

    if (spaceId !== rootSpaceId) {
      order.push(spaceId);
      subspaceCount += 1;
    }
  }

  visitSpace(rootSpaceId);
  return { order, roomCount, subspaceCount };
}

export function recursiveSpaceLeaveOrder(
  rooms: readonly RoomSummary[],
  rootSpaceId: string
): string[] {
  return [...joinedSpaceChildrenLeaveOrder(rooms, rootSpaceId).order, rootSpaceId];
}
