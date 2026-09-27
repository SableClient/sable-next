import type { TimelineItemView } from '#src/generated/protocol';

export type MediaItem = Extract<
  TimelineItemView['content'],
  { kind: 'image' | 'sticker' | 'video' | 'audio' | 'file' }
> & {
  eventId: string;
  sender: string;
};
