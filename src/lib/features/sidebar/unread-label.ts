import { i18n } from '#lib/i18n.js';
import type { UnreadCount } from '#lib/rooms/unread.js';

export function unreadLabel(count: UnreadCount | undefined): string | undefined {
  if (!count) return undefined;
  if (count.highlight > 0) return i18n.t('nav.unreadMentions', { count: count.highlight });
  if (count.unread > 0) return i18n.t('nav.unreadMessages', { count: count.unread });
  return count.marked ? i18n.t('nav.markedUnread') : undefined;
}
