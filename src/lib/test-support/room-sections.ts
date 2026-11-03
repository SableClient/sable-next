import type {
  RoomBadgeView,
  RoomSectionsUpdate,
  RoomSectionView,
  RoomUnreadView,
  SpaceTreeNodeView,
} from '#src/generated/protocol';

export const NO_COUNTS: RoomUnreadView = { unread: 0, notifying: 0, highlight: 0, marked: false };

export function sectionView(
  key: string,
  overrides: Partial<RoomSectionView> = {}
): RoomSectionView {
  return {
    key,
    favourites: [],
    rooms: [],
    subspaces: [],
    calendars: [],
    invites: [],
    unread: NO_COUNTS,
    unread_rooms: [],
    descendants: [],
    ...overrides,
  };
}

export function sectionsUpdate(
  sections: readonly RoomSectionView[],
  extra: Partial<Omit<RoomSectionsUpdate, 'sections'>> = {}
): RoomSectionsUpdate {
  return { sections: [...sections], removed: [], badges: null, quiet_rooms: null, ...extra };
}

export function badgeView(room_id: string, counts: Partial<RoomUnreadView>): RoomBadgeView {
  return { room_id, counts: { ...NO_COUNTS, ...counts } };
}

export function treeRoom(
  room_id: string,
  depth: number,
  key = `${room_id}@${depth}`
): SpaceTreeNodeView {
  return { kind: 'room', room_id, key, depth };
}

export function treeCategory(
  room_id: string,
  depth: number,
  children: SpaceTreeNodeView[]
): SpaceTreeNodeView {
  return { kind: 'category', room_id, key: `${room_id}@${depth}`, depth, children };
}

export function treeLink(room_id: string, depth: number): SpaceTreeNodeView {
  return { kind: 'link', room_id, key: `${room_id}@${depth}`, depth };
}
