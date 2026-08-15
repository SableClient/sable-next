import { afterEach, expect, test, vi } from 'vitest';

import type { TimelineItemView } from '@/generated/TimelineItemView';

import {
  estimateTimelineItemSize,
  rootFontSize,
  TIMELINE_LAYOUT,
  TIMELINE_LAYOUT_STYLE,
} from './timeline-layout';

afterEach(() => {
  vi.unstubAllGlobals();
});

test('publishes the estimator media dimensions as inherited CSS properties', () => {
  expect(TIMELINE_LAYOUT_STYLE).toBe('--timeline-media-max:32rem;--timeline-sticker-width:9.5rem');
});

test('reads a valid root font size and falls back for invalid values', () => {
  vi.stubGlobal('document', { documentElement: {} });
  vi.stubGlobal('getComputedStyle', () => ({ fontSize: '20px' }));
  expect(rootFontSize()).toBe(20);
  vi.stubGlobal('getComputedStyle', () => ({ fontSize: 'invalid' }));
  expect(rootFontSize()).toBe(16);
});

function media(
  kind: 'image' | 'video',
  width: number | null,
  height: number | null
): TimelineItemView {
  return {
    id: kind,
    event_id: `$${kind}`,
    transaction_id: null,
    send_state: null,
    sender: '@alice:example.org',
    sender_name: 'Alice',
    sender_avatar: null,
    timestamp: 0,
    content: { kind, body: '', source: 'mxc://example.org/media', mime: null, width, height },
    in_reply_to: null,
    thread_root: null,
    thread_summary: null,
    reactions: [],
    is_own: false,
    read_by: [],
    per_message_profile: null,
    mention: 'none',
  };
}

test('uses intrinsic video geometry when available', () => {
  const item = media('video', 1920, 1080);
  const rem = 16;
  const mediaWidth = Math.max(
    TIMELINE_LAYOUT.mediaMinRem * rem,
    (TIMELINE_LAYOUT.mediaMaxRem - TIMELINE_LAYOUT.messageInsetRem) * rem
  );
  expect(estimateTimelineItemSize([item], 0, TIMELINE_LAYOUT.mediaMaxRem * rem, rem)).toBe(
    mediaWidth * (9 / 16) + TIMELINE_LAYOUT.messageChromeRem * rem
  );
});

test('uses an explicit fallback for videos without dimensions', () => {
  const item = media('video', null, null);
  const rem = 16;
  expect(estimateTimelineItemSize([item], 0, TIMELINE_LAYOUT.mediaMaxRem * rem, rem)).toBe(
    Math.max(
      TIMELINE_LAYOUT.mediaMinRem * rem,
      (TIMELINE_LAYOUT.mediaMaxRem - TIMELINE_LAYOUT.messageInsetRem) * rem
    ) *
      TIMELINE_LAYOUT.videoRatio +
      TIMELINE_LAYOUT.messageChromeRem * rem
  );
});
