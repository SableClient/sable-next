import type { HierarchyRoomView, HierarchySection, SpaceChildEdge } from '#src/generated/protocol';

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
  localHierarchyRooms,
  mergeHierarchyRooms,
} from '#lib/model/model.js';

export type LobbyDragItem = { parentId: string; roomId: string | null };

export function sameLobbyItem(left: LobbyDragItem, right: LobbyDragItem): boolean {
  return left.parentId === right.parentId && left.roomId === right.roomId;
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
