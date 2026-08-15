import type { TimelineItemView } from '@/generated/TimelineItemView';

import { isCollapsed } from './timeline-format';

export const TIMELINE_LAYOUT = {
  historyPrefetchItems: 10,
  historyFillMaxPages: 4,
  historyRequestMinInterval: 300,
  jumpToLatestThreshold: 80,
  wheelGestureEndDelay: 150,
  mediaMaxRem: 32,
  mediaMinRem: 15,
  stickerWidthRem: 9.5,
  messageInsetRem: 4,
  fileHeightRem: 1.75,
  messageChromeRem: 2.75,
  captionHeightRem: 1.5,
  replyPreviewRem: 1.875,
  reactionsRem: 1.875,
  collapsedMessageRem: 3,
  messageRem: 4.5,
  dateDividerRem: 3.5,
  readMarkerRem: 2,
  separatorRem: 2.5,
  stateRowRem: 1.5,
  debugRowRem: 2.25,
  undecryptableRem: 2.5,
  audioHeightPx: 58,
  pictureRatio: 0.75,
  videoRatio: 9 / 16,
} as const;

export const TIMELINE_LAYOUT_STYLE = [
  `--timeline-media-max:${String(TIMELINE_LAYOUT.mediaMaxRem)}rem`,
  `--timeline-sticker-width:${String(TIMELINE_LAYOUT.stickerWidthRem)}rem`,
].join(';');

export function rootFontSize(): number {
  if (typeof document === 'undefined') return 16;
  const size = Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
  return Number.isFinite(size) && size > 0 ? size : 16;
}

function inverseAspectRatio(width: number | null, height: number | null, fallback: number): number {
  if (
    width === null ||
    height === null ||
    !Number.isFinite(width) ||
    !Number.isFinite(height) ||
    width <= 0 ||
    height <= 0
  ) {
    return fallback;
  }
  return height / width;
}

export function estimateTimelineItemSize(
  items: readonly TimelineItemView[],
  index: number,
  viewportWidth: number = TIMELINE_LAYOUT.mediaMaxRem * 16,
  rem: number = rootFontSize()
): number {
  const item = items[index];
  const contentWidth = Math.min(
    TIMELINE_LAYOUT.mediaMaxRem * rem,
    Math.max(
      TIMELINE_LAYOUT.mediaMinRem * rem,
      viewportWidth - TIMELINE_LAYOUT.messageInsetRem * rem
    )
  );
  const chrome = TIMELINE_LAYOUT.messageChromeRem * rem;
  const trimmings =
    (item.in_reply_to ? TIMELINE_LAYOUT.replyPreviewRem * rem : 0) +
    (item.reactions.length > 0 ? TIMELINE_LAYOUT.reactionsRem * rem : 0);

  switch (item.content.kind) {
    case 'message':
      return (
        (isCollapsed(items, index)
          ? TIMELINE_LAYOUT.collapsedMessageRem
          : TIMELINE_LAYOUT.messageRem) *
          rem +
        trimmings
      );
    case 'image': {
      const ratio = inverseAspectRatio(
        item.content.width,
        item.content.height,
        TIMELINE_LAYOUT.pictureRatio
      );
      const caption = item.content.body ? TIMELINE_LAYOUT.captionHeightRem * rem : 0;
      return (
        Math.min(TIMELINE_LAYOUT.mediaMaxRem * rem, contentWidth * ratio) +
        chrome +
        caption +
        trimmings
      );
    }
    case 'sticker': {
      const ratio = inverseAspectRatio(
        item.content.width,
        item.content.height,
        TIMELINE_LAYOUT.pictureRatio
      );
      return TIMELINE_LAYOUT.stickerWidthRem * rem * ratio + chrome + trimmings;
    }
    case 'video': {
      const ratio = inverseAspectRatio(
        item.content.width,
        item.content.height,
        TIMELINE_LAYOUT.videoRatio
      );
      return contentWidth * ratio + chrome + trimmings;
    }
    case 'audio':
      return TIMELINE_LAYOUT.audioHeightPx + chrome + trimmings;
    case 'file':
      return TIMELINE_LAYOUT.fileHeightRem * rem + chrome + trimmings;
    case 'date_divider':
      return TIMELINE_LAYOUT.dateDividerRem * rem;
    case 'read_marker':
      return TIMELINE_LAYOUT.readMarkerRem * rem;
    case 'membership':
    case 'profile_change':
    case 'redacted':
    case 'unsupported':
      return TIMELINE_LAYOUT.stateRowRem * rem;
    case 'state_event':
      return TIMELINE_LAYOUT.debugRowRem * rem;
    case 'unable_to_decrypt':
      return TIMELINE_LAYOUT.undecryptableRem * rem;
    default:
      return TIMELINE_LAYOUT.separatorRem * rem;
  }
}
