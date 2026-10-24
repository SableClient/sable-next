import type { ResolvedItem } from '#lib/rooms/timeline-item.js';

export type MediaItem = Extract<
  ResolvedItem['content'],
  { kind: 'image' | 'sticker' | 'video' | 'audio' | 'file' }
> & {
  eventId: string;
  sender: string;
};
