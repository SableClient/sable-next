import { describe, expect, test } from 'vitest';

import { initialTimelineScrollMode, isNearLatest } from './timeline-scroll';

describe('initialTimelineScrollMode', () => {
  test('starts at live when no event is focused', () => {
    expect(initialTimelineScrollMode(null)).toEqual({ kind: 'initialLive' });
  });

  test('retains the focused event id', () => {
    expect(initialTimelineScrollMode('$event')).toEqual({ kind: 'focused', eventId: '$event' });
  });
});

describe('isNearLatest', () => {
  test('includes the threshold boundary', () => {
    expect(isNearLatest({ scrollHeight: 1_000, scrollTop: 820, clientHeight: 100 }, 80)).toBe(true);
  });

  test('rejects a viewport beyond the threshold', () => {
    expect(isNearLatest({ scrollHeight: 1_000, scrollTop: 819, clientHeight: 100 }, 80)).toBe(
      false
    );
  });
});
