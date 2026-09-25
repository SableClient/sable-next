import type { TimelineItemView } from '#src/generated/protocol';
import { isPdfAttachment } from '#lib/ui/pdf-attachment.js';

import type { MediaItem } from './MediaViewer.svelte';

export function galleryItemId(eventId: string, index: number): string {
  return `${eventId}:gallery:${String(index)}`;
}

export function galleryEventId(id: string): string {
  return id.replace(/:gallery:\d+$/, '');
}

export function timelineMediaItems(entries: readonly TimelineItemView[]): MediaItem[] {
  return entries.flatMap((entry): MediaItem[] => {
    const eventId = entry.event_id;
    if (eventId === null) return [];
    const content = entry.content;
    const sender = entry.sender_name ?? entry.sender ?? 'Unknown sender';
    if (content.kind === 'gallery') {
      return content.items.flatMap((item, index): MediaItem[] => {
        const shared = {
          filename: item.filename,
          caption: item.caption,
          html: null,
          source: item.source,
          mime: item.mime,
          eventId: galleryItemId(eventId, index),
          sender,
        };
        if (item.kind === 'image') {
          return [
            {
              ...shared,
              kind: 'image',
              width: item.width,
              height: item.height,
              size: item.size,
              blurhash: item.blurhash,
              thumbnail: item.thumbnail,
              spoiler: item.spoiler,
            },
          ];
        }
        if (item.kind === 'file' && isPdfAttachment(item.mime, item.filename)) {
          return [{ ...shared, kind: 'file', size: item.size }];
        }
        return [];
      });
    }
    if (
      content.kind !== 'image' &&
      content.kind !== 'sticker' &&
      !(content.kind === 'file' && isPdfAttachment(content.mime, content.filename))
    ) {
      return [];
    }

    return [{ ...content, eventId, sender }];
  });
}
