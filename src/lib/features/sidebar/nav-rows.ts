import type { RoomListItemView } from '#src/generated/protocol';

import type { Thread } from './space-tree.js';

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
