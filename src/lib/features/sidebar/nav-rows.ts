import type { RoomListItemView } from '#src/generated/protocol';

import type { RoomSort } from '#lib/rooms/room-sort.js';

import type { SpaceTreeNode, Thread } from './space-tree.js';

export type RoomNavRow = {
  room?: RoomListItemView;
  roomId: string;
  parentSpaceId?: string;
  depth: number;
  kind: 'room';
  key: string;
  threads?: Thread[];
};

const roomRows = new WeakMap<RoomListItemView, RoomNavRow>();

export function roomRow(room: RoomListItemView): RoomNavRow {
  const cached = roomRows.get(room);
  if (cached) return cached;
  const row: RoomNavRow = {
    room,
    roomId: room.room_id,
    depth: 0,
    kind: 'room',
    key: room.room_id,
  };
  roomRows.set(room, row);
  return row;
}

function listPosition(listOrder: ReadonlyMap<string, number>, row: RoomNavRow): number {
  return listOrder.get(row.roomId) ?? Number.MAX_SAFE_INTEGER;
}

function byName(left: RoomNavRow, right: RoomNavRow): number {
  return (left.room?.name ?? '').localeCompare(right.room?.name ?? '', undefined, {
    sensitivity: 'base',
  });
}

/** `recent` keeps the core's room list order, which falls back to the recency stamp
 * while a room's latest event is still unknown. */
export function roomComparator(
  sort: RoomSort,
  listOrder: ReadonlyMap<string, number>
): (left: RoomNavRow, right: RoomNavRow) => number {
  if (sort === 'name-asc') return byName;
  if (sort === 'name-desc') return (left, right) => byName(right, left);
  return (left, right) => listPosition(listOrder, left) - listPosition(listOrder, right);
}

export function isFavourite(row: RoomNavRow): boolean {
  return row.room?.tags.includes('favourite') ?? false;
}

export function treeRows(items: SpaceTreeNode[]): RoomNavRow[] {
  return items.flatMap((item) => (item.kind === 'room' ? [item] : treeRows(item.children)));
}

export function withoutFavourites(items: SpaceTreeNode[]): SpaceTreeNode[] {
  return items.flatMap<SpaceTreeNode>((item) => {
    if (item.kind === 'room') return isFavourite(item) ? [] : [item];
    if (item.kind === 'link') return [item];
    const children = withoutFavourites(item.children);
    return children.length === 0 ? [] : [{ ...item, children }];
  });
}
