import type { NotificationModeView, RoomListItemView } from '#src/generated/protocol';

import { roomNotifications, roomUnread } from '#lib/rooms/unread.js';

const NO_TYPING: ReadonlyMap<string, readonly string[]> = new Map();
const NO_ROOMS: ReadonlySet<string> = new Set();

export function streamedRoomList() {
  let rooms = $state.raw<RoomListItemView[]>([]);
  return {
    get rooms() {
      return rooms;
    },
    set rooms(next: RoomListItemView[]) {
      rooms = next;
    },
    typingUsers: NO_TYPING,
    warm: () => {},
    byId: (roomId: string | null) => rooms.find((room) => room.room_id === roomId),
    notificationOverride: () => null,
    notificationMode: (): NotificationModeView => 'all',
    mutedRoomIds: NO_ROOMS,
    section: (key: string) => ({
      key,
      favourites: [],
      rooms: rooms.map((room) => room.room_id),
      subspaces: [],
      calendars: [],
      invites: [],
      unread: { unread: 0, notifying: 0, highlight: 0, marked: false },
      unread_rooms: [],
      descendants: [],
    }),
    quietRoomIds: NO_ROOMS,
    unreadFor: (room: RoomListItemView) => roomUnread(room),
    badgeUnreadFor: (room: RoomListItemView) => roomUnread(room),
    notificationsFor: (room: RoomListItemView) => roomNotifications(room),
  };
}
