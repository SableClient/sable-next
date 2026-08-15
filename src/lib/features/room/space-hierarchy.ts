import type { SpaceHierarchyRoomView } from '@/generated/SpaceHierarchyRoomView';

export type HierarchyRoom = {
  room: SpaceHierarchyRoomView;
  /** The parent marked it suggested; the same room may differ per parent. */
  suggested: boolean;
  /** Unique across repeats: one room may hang off several parents. */
  key: string;
};

export type HierarchySection = {
  /** `null` for the root's own rooms, which sit under a plain "Rooms" heading. */
  space: SpaceHierarchyRoomView | null;
  suggested: boolean;
  /** Nesting under the root space; the root's own section is 0. */
  depth: number;
  key: string;
  rooms: HierarchyRoom[];
};

/**
 * Groups the tree the way v1's lobby does: the root's own rooms first, then one
 * section per subspace headed by that space. Order comes from each parent's
 * `m.space.child` edges rather than the order the server returned rooms in.
 *
 * Sections with no rooms are dropped, so a subspace never renders as a lone
 * heading.
 */
export function buildHierarchySections(
  rooms: readonly SpaceHierarchyRoomView[],
  rootId: string
): HierarchySection[] {
  const byId = new Map(rooms.map((room) => [room.room_id, room]));
  const sections: HierarchySection[] = [];

  function walk(
    spaceId: string,
    space: SpaceHierarchyRoomView | null,
    suggested: boolean,
    depth: number,
    ancestry: readonly string[]
  ): void {
    const current = byId.get(spaceId);
    if (!current) return;

    const ownRooms: HierarchyRoom[] = [];
    const subspaces: { room: SpaceHierarchyRoomView; suggested: boolean }[] = [];

    for (const edge of current.children) {
      const child = byId.get(edge.room_id);
      if (!child) continue;

      if (child.is_space) {
        subspaces.push({ room: child, suggested: edge.suggested });
        continue;
      }
      ownRooms.push({
        room: child,
        suggested: edge.suggested,
        key: [...ancestry, child.room_id].join('/'),
      });
    }

    if (ownRooms.length > 0) {
      sections.push({ space, suggested, depth, key: ancestry.join('/'), rooms: ownRooms });
    }

    for (const subspace of subspaces) {
      // A space reachable from itself would recurse forever.
      if (ancestry.includes(subspace.room.room_id)) continue;
      walk(subspace.room.room_id, subspace.room, subspace.suggested, depth + 1, [
        ...ancestry,
        subspace.room.room_id,
      ]);
    }
  }

  walk(rootId, null, false, 0, [rootId]);
  return sections;
}
