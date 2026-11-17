import type {
  RoomAttachmentContentView,
  RoomAttachmentKind,
  RoomAttachmentView,
} from '#src/generated/protocol';

import { i18n } from '#lib/i18n.js';
import { afterOverlayPops } from '#lib/platform/overlay-back.svelte.js';
import { formatDate } from '#lib/ui/date-time.js';
import { galleryItemId } from '#lib/ui/media/media-items.js';

const CONTENT_KINDS = {
  media: ['image', 'video'],
  file: ['file'],
  link: ['link'],
} as const satisfies Record<RoomAttachmentKind, readonly RoomAttachmentContentView['kind'][]>;

export type RoomAttachmentOf<K extends RoomAttachmentKind> = Omit<RoomAttachmentView, 'content'> & {
  content: Extract<RoomAttachmentContentView, { kind: (typeof CONTENT_KINDS)[K][number] }>;
};

export interface TileProps {
  tabindex: number;
  'data-attachment-tile': '';
  onfocus: () => void;
  onkeydown: (event: KeyboardEvent) => void;
}

export function isAttachmentOf<K extends RoomAttachmentKind>(
  kind: K,
  item: RoomAttachmentView
): item is RoomAttachmentOf<K> {
  const kinds: readonly string[] = CONTENT_KINDS[kind];
  return kinds.includes(item.content.kind);
}

export function attachmentKey(item: RoomAttachmentView): string {
  return item.gallery_index === null
    ? item.event_id
    : galleryItemId(item.event_id, item.gallery_index);
}

export function attachmentLabel(item: RoomAttachmentView, name: string, sender: string): string {
  return i18n.t('timeline.attachmentsOpenItem', {
    name,
    sender,
    date: formatDate(item.timestamp),
  });
}

export function viewerFields(item: RoomAttachmentView, sender: string) {
  return {
    eventId: attachmentKey(item),
    sender,
    caption: null,
    html: null,
    external_url: null,
  };
}

export function afterClosing(
  modal: boolean,
  onClose: (() => void) | undefined,
  action: () => void
): void {
  if (!modal) {
    action();
    return;
  }
  onClose?.();
  void afterOverlayPops().then(action);
}

export function closingJump(
  modal: boolean,
  onClose: (() => void) | undefined,
  onJump: (eventId: string) => void
): (eventId: string) => void {
  return (eventId) => {
    afterClosing(modal, onClose, () => {
      onJump(eventId);
    });
  };
}
