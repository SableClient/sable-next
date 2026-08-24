import type { RoomJoinRuleView } from '#src/generated/RoomJoinRuleView';
import type { RoomSummary } from '#src/generated/RoomSummary';
import type { SpaceChildEdge } from '#src/generated/SpaceChildEdge';
import type { SpaceHierarchyRoomView } from '#src/generated/SpaceHierarchyRoomView';

export type HierarchyRoomView = Omit<SpaceHierarchyRoomView, 'num_joined_members'> & {
  num_joined_members: number | null;
};

export type HierarchyRoom = {
  room: HierarchyRoomView;
  suggested: boolean;
  key: string;
};

export type HierarchySection = {
  space: HierarchyRoomView | null;
  suggested: boolean;
  depth: number;
  key: string;
  rooms: HierarchyRoom[];
  parentId: string;
  siblings: SpaceChildEdge[];
  loaded: boolean;
  failed: boolean;
  pending: number;
};

export function lobbyAction(joinRule: RoomJoinRuleView, invited: boolean): 'join' | 'knock' | null {
  if (invited || ['public', 'restricted', 'knock_restricted'].includes(joinRule)) return 'join';
  if (joinRule === 'knock') return 'knock';
  return null;
}

export function localHierarchyRooms(
  rooms: readonly RoomSummary[],
  rootId: string
): HierarchyRoomView[] {
  const byId = new Map(rooms.map((room) => [room.room_id, room]));
  const views: HierarchyRoomView[] = [];
  const seen = new Set<string>();
  const queue: string[] = [rootId];

  for (let at = 0; at < queue.length; at += 1) {
    const roomId = queue[at];
    if (seen.has(roomId)) continue;
    seen.add(roomId);

    const summary = byId.get(roomId);
    if (!summary) continue;

    const children =
      summary.is_space && summary.state === 'joined' ? [...summary.space_children] : [];
    views.push({
      room_id: summary.room_id,
      canonical_alias: summary.canonical_alias,
      name: summary.name,
      topic: summary.topic,
      avatar_url: summary.avatar_url,
      is_space: summary.is_space,
      is_voice: summary.is_voice,
      num_joined_members: null,
      join_rule: summary.join_rule,
      guest_can_join: false,
      children,
    });

    for (const edge of children) queue.push(edge.room_id);
  }

  return views;
}

export function mergeHierarchyRooms(
  local: readonly HierarchyRoomView[],
  fetched: readonly SpaceHierarchyRoomView[]
): HierarchyRoomView[] {
  const merged = new Map<string, HierarchyRoomView>();
  for (const room of fetched) merged.set(room.room_id, room);

  for (const room of local) {
    const chunk = merged.get(room.room_id);
    if (chunk === undefined) {
      merged.set(room.room_id, room);
      continue;
    }

    merged.set(room.room_id, {
      ...room,
      name: room.name ?? chunk.name,
      topic: room.topic ?? chunk.topic,
      avatar_url: room.avatar_url ?? chunk.avatar_url,
      canonical_alias: room.canonical_alias ?? chunk.canonical_alias,
      num_joined_members: chunk.num_joined_members,
      guest_can_join: chunk.guest_can_join,
      children: room.children.length > 0 ? room.children : chunk.children,
    });
  }

  return [...merged.values()];
}

export function buildHierarchySections(
  rooms: readonly HierarchyRoomView[],
  rootId: string,
  levels: { loaded?: ReadonlySet<string>; failed?: ReadonlySet<string> } = {}
): HierarchySection[] {
  const byId = new Map(rooms.map((room) => [room.room_id, room]));
  const sections: HierarchySection[] = [];
  const described = (spaceId: string): boolean =>
    levels.loaded === undefined || levels.loaded.has(spaceId);
  const refused = (spaceId: string): boolean => levels.failed?.has(spaceId) ?? false;

  function walk(
    spaceId: string,
    space: HierarchyRoomView | null,
    suggested: boolean,
    depth: number,
    ancestry: readonly string[]
  ): void {
    const current = byId.get(spaceId);
    if (!current) return;

    const ownRooms: HierarchyRoom[] = [];
    const subspaces: { room: HierarchyRoomView; suggested: boolean }[] = [];
    let pending = 0;

    for (const edge of current.children) {
      const child = byId.get(edge.room_id);
      if (!child) {
        pending += 1;
        continue;
      }

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

    if (ownRooms.length > 0 || !described(spaceId) || refused(spaceId)) {
      sections.push({
        space,
        suggested,
        depth,
        key: ancestry.join('/'),
        rooms: ownRooms,
        parentId: spaceId,
        siblings: current.children,
        loaded: described(spaceId),
        failed: refused(spaceId),
        pending,
      });
    }

    for (const subspace of subspaces) {
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

const MIN_PLACEHOLDER_ROWS = 3;
const MAX_PLACEHOLDER_ROWS = 10;

export function placeholderRows(section: HierarchySection): number {
  if (section.failed || section.loaded) return 0;
  if (section.pending > 0) return Math.min(section.pending, MAX_PLACEHOLDER_ROWS);
  return section.rooms.length > 0 ? 0 : MIN_PLACEHOLDER_ROWS;
}

export type LobbyPhase = 'loading' | 'empty' | 'ready';

export function lobbyPhase(sectionCount: number, loading: boolean): LobbyPhase {
  if (sectionCount > 0) return 'ready';
  return loading ? 'loading' : 'empty';
}

export type ChildOrderOverride = {
  parentId: string;
  children: SpaceChildEdge[];
  baseline: string;
};

export function edgeSignature(edges: readonly SpaceChildEdge[]): string {
  return edges.map((edge) => `${edge.room_id}:${edge.order ?? ''}`).join('|');
}

export function childEdges(
  rooms: readonly HierarchyRoomView[],
  parentId: string
): readonly SpaceChildEdge[] {
  return rooms.find((room) => room.room_id === parentId)?.children ?? [];
}

export function applyChildOverrides(
  rooms: readonly HierarchyRoomView[],
  overrides: readonly ChildOrderOverride[]
): HierarchyRoomView[] {
  if (overrides.length === 0) return [...rooms];

  const byParent = new Map(overrides.map((override) => [override.parentId, override.children]));
  return rooms.map((room) => {
    const children = byParent.get(room.room_id);
    return children === undefined ? room : { ...room, children };
  });
}

export function levelTargets(
  sections: readonly HierarchySection[],
  rootId: string,
  closed: ReadonlySet<string> = new Set()
): string[] {
  const targets = [rootId];
  for (const section of sections) {
    const spaceId = section.space?.room_id;
    if (spaceId === undefined || targets.includes(spaceId)) continue;
    if (closed.has(section.key)) continue;
    targets.push(spaceId);
  }
  return targets;
}
