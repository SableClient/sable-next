import type { NotificationSettingsView, RoomListItemView } from '#src/generated/protocol';

type RawSummary = Omit<
  RoomListItemView,
  'notification' | 'counts' | 'display_name' | 'display_avatar_url'
> & {
  notification?: NotificationSettingsView;
  display_name?: string;
  display_avatar_url?: string | null;
};

/** What the core resolves from the raw counts, for summaries a test builds by hand. */
export function withCounts(room: RawSummary): RoomListItemView {
  const notification = room.notification ?? {
    room: null,
    default: room.is_direct ? 'all' : 'mentions',
  };
  const muted = (notification.room ?? notification.default) === 'mute';
  return {
    ...room,
    display_name: room.display_name ?? room.name ?? room.canonical_alias ?? room.room_id,
    display_avatar_url:
      room.display_avatar_url === undefined ? room.avatar_url : room.display_avatar_url,
    notification,
    counts: {
      unread: muted ? 0 : Math.max(room.unread, room.highlight),
      notifying: muted ? 0 : Math.max(room.notifying, room.highlight),
      highlight: muted ? 0 : room.highlight,
      marked: room.marked_unread,
    },
  };
}
