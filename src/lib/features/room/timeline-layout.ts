export const TIMELINE_LAYOUT = {
  historyPrefetchItems: 25,
  initialFillSettleTimeout: 3_000,
  initialFillPollInterval: 25,
  historyRequestMinInterval: 300,
  historyLoadingLinger: 500,
  historyLoadingFade: 180,
  jumpToLatestRem: 5,
  wheelGestureEndDelay: 150,
  mediaMaxRem: 25,
  stickerWidthRem: 9.5,
} as const;

export const TIMELINE_LAYOUT_STYLE = [
  `--timeline-media-max:${String(TIMELINE_LAYOUT.mediaMaxRem)}rem`,
  `--timeline-sticker-width:${String(TIMELINE_LAYOUT.stickerWidthRem)}rem`,
].join(';');
