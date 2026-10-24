import type { ResolvedItem } from '#lib/rooms/timeline-item.js';

export type MediaCaptionContent = Extract<
  ResolvedItem['content'],
  { kind: 'image' | 'video' | 'audio' | 'file' }
>;

export function isMediaCaptionContent(
  content: ResolvedItem['content']
): content is MediaCaptionContent {
  return (
    content.kind === 'image' ||
    content.kind === 'video' ||
    content.kind === 'audio' ||
    content.kind === 'file'
  );
}
