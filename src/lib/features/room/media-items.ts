import type { TimelineItemView } from '#src/generated/protocol';
import { isPdfAttachment } from '#lib/ui/pdf-attachment.js';

import type { MediaItem } from './MediaViewer.svelte';

export function timelineMediaItems(entries: readonly TimelineItemView[]): MediaItem[] {
  return entries.flatMap((entry) => {
    const eventId = entry.event_id;
    if (eventId === null) return [];
    const content = entry.content;
    if (content.kind === 'gallery') {
      return content.items.flatMap((item, index) => {
        if (item.kind !== 'image') return [];

        return [
          {
            kind: 'image',
            filename: item.body,
            caption: null,
            html: null,
            source: item.source,
            mime: item.mime,
            width: item.width,
            height: item.height,
            size: null,
            blurhash: null,
            spoiler: null,
            eventId: `${eventId}:gallery:${index}`,
            sender: entry.sender_name ?? entry.sender ?? 'Unknown sender',
          },
        ];
      });
    }
    if (
      content.kind !== 'image' &&
      content.kind !== 'sticker' &&
      !(content.kind === 'file' && isPdfAttachment(content.mime, content.filename))
    ) {
      return [];
    }

    return [
      {
        ...content,
        eventId,
        sender: entry.sender_name ?? entry.sender ?? 'Unknown sender',
      },
    ];
  });
}
