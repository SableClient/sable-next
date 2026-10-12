import type { NotificationSettingsView, RoomSummary } from '#src/generated/protocol';

type RawSummary = Omit<RoomSummary, 'notification' | 'counts'> & {
  notification?: NotificationSettingsView;
};

/** What the core resolves from the raw counts, for summaries a test builds by hand. */
export function withCounts(room: RawSummary): RoomSummary {
  const notification = room.notification ?? {
    room: null,
    default: room.is_direct ? 'all' : 'mentions',
  };
  const muted = (notification.room ?? notification.default) === 'mute';
  return {
    ...room,
    notification,
    counts: {
      unread: muted ? 0 : Math.max(room.unread, room.highlight),
      notifying: muted ? 0 : Math.max(room.notifying, room.highlight),
      highlight: muted ? 0 : room.highlight,
      marked: room.marked_unread,
    },
  };
}
