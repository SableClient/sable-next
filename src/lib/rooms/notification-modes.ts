import type { NotificationModeView } from '#src/generated/protocol';

export const notificationModeLabels: Record<NotificationModeView, string> = {
  all: 'room.notifyAll',
  mentions: 'room.notifyMentions',
  mute: 'room.notifyMute',
};
