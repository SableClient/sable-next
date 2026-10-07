import type { TimelineItemContentView } from '#src/generated/protocol';
import type { MessageSpacing } from '#lib/settings/preferences.svelte.js';

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

export function timelineLayoutStyle(spacing: MessageSpacing): string {
  const padding = {
    compact: 'var(--space-050)',
    cozy: 'var(--space-100)',
    roomy: 'var(--space-200)',
  }[spacing];
  return [
    TIMELINE_LAYOUT_STYLE,
    '--timeline-row-gap:var(--space-300)',
    '--timeline-group-gap:var(--space-200)',
    `--timeline-row-padding:${padding}`,
  ].join(';');
}

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

function pictureRow(columnPx: number, ratio: number, intrinsicPx = Infinity): number {
  const heightCapPx = TIMELINE_LAYOUT.mediaMaxRem * ROOT_FONT_PX;
  const width = Math.min(
    columnPx,
    Math.max(TIMELINE_LAYOUT.mediaMinRem * ROOT_FONT_PX, Math.min(heightCapPx * ratio, intrinsicPx))
  );
  return Math.min(width / ratio, heightCapPx) + TIMELINE_LAYOUT.mediaRowChromePx;
}

export function estimateRowSize(
  content: TimelineItemContentView,
  columnPx: number
): number | undefined {
  if (content.kind === 'image' || content.kind === 'video') {
    const ratio = pictureRatio(content.width, content.height);
    const intrinsic =
      content.kind === 'image' && content.height !== null
        ? (content.width ?? undefined)
        : undefined;
    return pictureRow(columnPx, ratio, intrinsic);
  }
  if (content.kind === 'sticker') {
    const width = TIMELINE_LAYOUT.stickerWidthRem * ROOT_FONT_PX;
    return width / pictureRatio(content.width, content.height) + TIMELINE_LAYOUT.mediaRowChromePx;
  }
  return undefined;
}
