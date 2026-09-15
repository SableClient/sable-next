import type { TimelineItemContentView } from '#src/generated/protocol';

export const TIMELINE_LAYOUT = {
  historyPrefetchItems: 25,
  initialFillSettleTimeout: 3_000,
  initialFillPollInterval: 25,
  historyRequestMinInterval: 300,
  historyLoadingLinger: 500,
  historyLoadingFade: 150,
  jumpToLatestRem: 5,
  jumpToLatestPages: 1,
  wheelGestureEndDelay: 150,
  mediaMaxRem: 25,
  mediaMinRem: 8,
  mediaInsetRem: 4.375,
  mediaRowChromePx: 48,
  stickerWidthRem: 9.5,
} as const;

export const TIMELINE_LAYOUT_STYLE = [
  `--timeline-media-max:${String(TIMELINE_LAYOUT.mediaMaxRem)}rem`,
  `--timeline-media-min:${String(TIMELINE_LAYOUT.mediaMinRem)}rem`,
  `--timeline-sticker-width:${String(TIMELINE_LAYOUT.stickerWidthRem)}rem`,
].join(';');

const ROOT_FONT_PX = 16;
const DEFAULT_PICTURE_RATIO = 4 / 3;

function pictureRatio(width: number | null, height: number | null): number {
  return width !== null && height !== null && width > 0 && height > 0
    ? width / height
    : DEFAULT_PICTURE_RATIO;
}

export function mediaColumnPx(columnWidth: number): number {
  return Math.max(
    TIMELINE_LAYOUT.mediaMinRem * ROOT_FONT_PX,
    Math.min(columnWidth, TIMELINE_LAYOUT.mediaMaxRem * ROOT_FONT_PX)
  );
}

export function estimatedColumnPx(viewportWidth: number): number {
  return viewportWidth - TIMELINE_LAYOUT.mediaInsetRem * ROOT_FONT_PX;
}

function pictureRow(columnPx: number, ratio: number): number {
  const heightCapPx = TIMELINE_LAYOUT.mediaMaxRem * ROOT_FONT_PX;
  const width = Math.min(
    columnPx,
    Math.max(TIMELINE_LAYOUT.mediaMinRem * ROOT_FONT_PX, heightCapPx * ratio)
  );
  return Math.min(width / ratio, heightCapPx) + TIMELINE_LAYOUT.mediaRowChromePx;
}

export function estimateRowSize(
  content: TimelineItemContentView,
  columnPx: number
): number | undefined {
  if (content.kind === 'image' || content.kind === 'video')
    return pictureRow(columnPx, pictureRatio(content.width, content.height));
  if (content.kind === 'sticker') {
    const width = TIMELINE_LAYOUT.stickerWidthRem * ROOT_FONT_PX;
    return width / pictureRatio(content.width, content.height) + TIMELINE_LAYOUT.mediaRowChromePx;
  }
  return undefined;
}
