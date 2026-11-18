import type { CoreClient } from '#lib/core/client.svelte.js';
import { i18n } from '#lib/i18n.js';
import type { RoomTimeline } from '#lib/rooms/timeline.svelte.js';
import { toasts } from '#lib/ui/toasts.svelte.js';
import { eventBefore } from './timeline/timeline-format';

interface UnreadControls {
  markUnreadFrom(eventId: string, readEventId: string | null): void;
  dismissUnread(): void;
}

export class RoomReadActions {
  constructor(
    private readonly core: Pick<CoreClient, 'rpc'>,
    private readonly roomId: () => string,
    private readonly timeline: Pick<RoomTimeline, 'items' | 'subscriptionId'>,
    private readonly list: () => UnreadControls | undefined
  ) {}

  markRead = async (eventId: string, fullyRead: boolean): Promise<void> => {
    await this.core.rpc.timeline.markRead({
      room_id: this.roomId(),
      event_id: eventId,
      thread_root: null,
      subscription: this.timeline.subscriptionId,
      fully_read: fullyRead,
    });
  };

  setFullyRead = (roomId: string, eventId: string): void => {
    void this.core.rpc.timeline
      .setFullyRead({ room_id: roomId, event_id: eventId })
      .catch((error: unknown) => {
        console.warn('[sable room] moving the read marker failed', error);
      });
  };

  markUnreadFrom = (eventId: string): void => {
    const readMarker = eventBefore(this.timeline.items, eventId);
    this.list()?.markUnreadFrom(eventId, readMarker);
    void this.core.rpc.timeline
      .markUnread({ room_id: this.roomId(), read_marker: readMarker })
      .catch((error: unknown) => {
        console.warn('[sable room] mark as unread failed', error);
        toasts.error(i18n.t('errors.actionFailed'));
      });
  };

  markRoomRead = (): void => {
    void this.markAllRead().catch((error: unknown) => {
      console.warn('[sable room] mark as read failed', error);
      toasts.error(i18n.t('errors.actionFailed'));
    });
  };

  markAllRead = async (): Promise<void> => {
    const list = this.list();
    await this.core.rpc.timeline.markRead({
      room_id: this.roomId(),
      event_id: null,
      thread_root: null,
      subscription: null,
      fully_read: true,
    });
    list?.dismissUnread();
  };

  loadReadMarker = (): Promise<string | null> => {
    return this.core.rpc.timeline.readMarker({ room_id: this.roomId() });
  };

  markRoomUnread = (): void => {
    void this.core.rpc.timeline
      .markUnread({ room_id: this.roomId(), read_marker: null })
      .catch((error: unknown) => {
        console.warn('[sable room] mark as unread failed', error);
        toasts.error(i18n.t('errors.actionFailed'));
      });
  };
}
