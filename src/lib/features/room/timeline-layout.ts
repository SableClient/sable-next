import type { TimelineItemView } from '#src/generated/TimelineItemView';

import type { TimelineLayout } from '#lib/settings/preferences.svelte.js';

import { isCollapsed } from './timeline-format';

export const TIMELINE_LAYOUT = {
  /* Roughly a screenful of rows, so a page is requested while the reader still
     has that much left to read. At 10 the request only started once they were
     almost at the top, and a slow page left them waiting there. */
  historyPrefetchItems: 25,
  historyFillMaxPages: 4,
  initialFillMaxPages: 4,
  /* One screenful: the fill removes empty space, it does not prefetch. */
  initialFillViewports: 1,
  /* A lost diff must still reveal the timeline rather than leave it hidden. */
  initialFillSettleTimeout: 3_000,
  initialFillPollInterval: 25,
  historyRequestMinInterval: 300,
  jumpToLatestRem: 5,
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
  collapsedMessageRem: 2,
  messageRem: 4.5,
  dateDividerRem: 3.5,
  readMarkerRem: 2,
  separatorRem: 2.5,
  stateRowRem: 1.5,
  debugRowRem: 2.25,
  undecryptableRem: 2.5,
  audioHeightPx: 58,
  /** Matches the collapse threshold in FormattedBody. */
  codeLineLimit: 14,
  /** Measured: the mono font's metrics push the line box past --code-line-height. */
  codeLineRem: 1.3125,
  codeChromeRem: 3.875,
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

/** Every mode obeys the same measurement contract; only these three move. */
export const LAYOUT_METRICS: Record<
  TimelineLayout,
  { message: number; collapsed: number; chrome: number }
> = {
  modern: {
    message: TIMELINE_LAYOUT.messageRem,
    collapsed: TIMELINE_LAYOUT.collapsedMessageRem,
    chrome: TIMELINE_LAYOUT.messageChromeRem,
  },
  compact: { message: 2.25, collapsed: 1.75, chrome: 1.5 },
  bubble: { message: 5, collapsed: 3.5, chrome: 3.25 },
};

/**
 * A code block is many rows tall inside a message the estimator would otherwise
 * size as one line, so the row settles visibly after measurement. Counting the
 * newlines is cheap and bounded by the same cap the collapsed block uses.
 */
export function codeBlockHeight(html: string, rem: number): number {
  if (!html.includes('<pre')) return 0;

  let total = 0;
  for (const block of html.split('<pre').slice(1)) {
    const end = block.indexOf('</pre>');
    const body = end === -1 ? block : block.slice(0, end);
    const lines = Math.min(body.split('\n').length, TIMELINE_LAYOUT.codeLineLimit);
    total += lines * TIMELINE_LAYOUT.codeLineRem * rem + TIMELINE_LAYOUT.codeChromeRem * rem;
  }
  return total;
}

export function trimmingsHeight(item: TimelineItemView, rem: number): number {
  return (
    (item.in_reply_to ? TIMELINE_LAYOUT.replyPreviewRem * rem : 0) +
    (item.reactions.length > 0 ? TIMELINE_LAYOUT.reactionsRem * rem : 0)
  );
}

export function estimateTimelineItemSize(
  items: readonly TimelineItemView[],
  index: number,
  viewportWidth: number = TIMELINE_LAYOUT.mediaMaxRem * 16,
  rem: number = rootFontSize(),
  layout: TimelineLayout = 'modern'
): number {
  const item = items[index];
  const metrics = LAYOUT_METRICS[layout];
  const contentWidth = Math.min(
    TIMELINE_LAYOUT.mediaMaxRem * rem,
    Math.max(
      TIMELINE_LAYOUT.mediaMinRem * rem,
      viewportWidth - TIMELINE_LAYOUT.messageInsetRem * rem
    )
  );
  const chrome = metrics.chrome * rem;
  const trimmings = trimmingsHeight(item, rem);

  switch (item.content.kind) {
    case 'message': {
      const collapsed = isCollapsed(items, index);
      const base = (collapsed ? metrics.collapsed : metrics.message) * rem;
      return base + codeBlockHeight(item.content.html, rem) + trimmings;
    }
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
