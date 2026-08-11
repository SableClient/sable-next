import { expect, test } from 'vitest';

import type { TimelineItemView } from '@/generated/TimelineItemView';

import { readReceiptEventId } from './timeline-format';

const items = [{ event_id: '$latest' }] as TimelineItemView[];
const visibleAtLatest = {
  focusEventId: null,
  initialAnchorComplete: true,
  nearLatest: true,
  documentVisible: true,
  lastReadEventId: null,
};

test('marks the latest live event read only when the live end is visible', () => {
  expect(readReceiptEventId(items, visibleAtLatest)).toBe('$latest');
  expect(readReceiptEventId(items, { ...visibleAtLatest, nearLatest: false })).toBeNull();
  expect(readReceiptEventId(items, { ...visibleAtLatest, lastReadEventId: '$latest' })).toBeNull();
});

test('does not mark permalink context events as read', () => {
  expect(readReceiptEventId(items, { ...visibleAtLatest, focusEventId: '$target' })).toBeNull();
});
