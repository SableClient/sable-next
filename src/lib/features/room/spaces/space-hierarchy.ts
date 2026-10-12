import type {
  HierarchyRoomView,
  HierarchySection,
  RoomSummary,
  SpaceChildEdge,
} from '#src/generated/protocol';

import * as model from '#lib/model/model.js';

export type {
  HierarchyRoom,
  HierarchyRoomView,
  HierarchySection,
  JoinCandidate,
  LobbyAction,
} from '#src/generated/protocol';
export {
  buildHierarchySections,
  joinCandidates,
  lobbyAction,
  mergeHierarchyRooms,
} from '#lib/model/model.js';

export type LobbyDragItem = { parentId: string; roomId: string | null };

export function sameLobbyItem(left: LobbyDragItem, right: LobbyDragItem): boolean {
  return left.parentId === right.parentId && left.roomId === right.roomId;
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
      allowed_room_ids: [],
      guest_can_join: false,
      children,
    });

    for (const edge of children) queue.push(edge.room_id);
  }

  return views;
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

export function applyChildOverrides(
  rooms: readonly HierarchyRoomView[],
  overrides: readonly ChildOrderOverride[]
): HierarchyRoomView[] {
  if (overrides.length === 0) return [...rooms];
  return model.applyChildOverrides(
    rooms,
    overrides.map(({ parentId, children }) => ({ parent_id: parentId, children }))
  );
}

export function edgeSignature(edges: readonly SpaceChildEdge[]): string {
  return edges.map((edge) => `${edge.room_id}:${edge.order ?? ''}`).join('|');
}

export function childEdges(
  rooms: readonly HierarchyRoomView[],
  parentId: string
): readonly SpaceChildEdge[] {
  return rooms.find((room) => room.room_id === parentId)?.children ?? [];
}

export type SuggestedOverride = {
  parentId: string;
  roomId: string;
  suggested: boolean;
};

export function applySuggestedOverrides(
  rooms: readonly HierarchyRoomView[],
  overrides: readonly SuggestedOverride[]
): HierarchyRoomView[] {
  if (overrides.length === 0) return [...rooms];
  return model.applySuggestedOverrides(
    rooms,
    overrides.map(({ parentId, roomId, suggested }) => ({
      parent_id: parentId,
      room_id: roomId,
      suggested,
    }))
  );
}

export function pendingSuggestedOverrides(
  rooms: readonly HierarchyRoomView[],
  overrides: readonly SuggestedOverride[]
): SuggestedOverride[] {
  return overrides.filter(
    (override) =>
      childEdges(rooms, override.parentId).find((edge) => edge.room_id === override.roomId)
        ?.suggested !== override.suggested
  );
}

export function levelTargets(
  sections: readonly HierarchySection[],
  rootId: string,
  visible: ReadonlySet<string> = new Set()
): string[] {
  const targets = [rootId];
  for (const section of sections) {
    const spaceId = section.space?.room_id;
    if (spaceId === undefined || targets.includes(spaceId)) continue;
    if (!visible.has(section.key)) continue;
    targets.push(spaceId);
  }
  return targets;
}
