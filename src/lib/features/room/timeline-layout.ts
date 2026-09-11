import type { TimelineItemContentView } from '#src/generated/protocol';

export const TIMELINE_LAYOUT = {
  historyPrefetchItems: 25,
  initialFillSettleTimeout: 3_000,
  initialFillPollInterval: 25,
  historyRequestMinInterval: 300,
  historyLoadingLinger: 500,
  historyLoadingFade: 180,
  jumpToLatestRem: 5,
  jumpToLatestPages: 1,
  wheelGestureEndDelay: 150,
  mediaMaxRem: 25,
  mediaRowChromePx: 48,
  stickerWidthRem: 9.5,
} as const;

export const TIMELINE_LAYOUT_STYLE = [
  `--timeline-media-max:${String(TIMELINE_LAYOUT.mediaMaxRem)}rem`,
  `--timeline-sticker-width:${String(TIMELINE_LAYOUT.stickerWidthRem)}rem`,
].join(';');

const ROOT_FONT_PX = 16;
const DEFAULT_PICTURE_RATIO = 4 / 3;

function pictureRow(widthRem: number, width: number | null, height: number | null): number {
  const ratio =
    width !== null && height !== null && width > 0 && height > 0
      ? width / height
      : DEFAULT_PICTURE_RATIO;
  return (widthRem * ROOT_FONT_PX) / ratio + TIMELINE_LAYOUT.mediaRowChromePx;
}

export function estimateRowSize(content: TimelineItemContentView): number | undefined {
  if (content.kind === 'image' || content.kind === 'video')
    return pictureRow(TIMELINE_LAYOUT.mediaMaxRem, content.width, content.height);
  if (content.kind === 'sticker')
    return pictureRow(TIMELINE_LAYOUT.stickerWidthRem, content.width, content.height);
  return undefined;
}
