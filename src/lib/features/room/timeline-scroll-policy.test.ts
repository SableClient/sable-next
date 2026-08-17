import { describe, expect, test } from 'vitest';

import { nextScrollMode, type ScrollModeSignals } from './timeline-scroll-policy';
import type { TimelineScrollMode } from './timeline-scroll';

function signals(overrides: Partial<ScrollModeSignals> = {}): ScrollModeSignals {
  return {
    timelineMode: 'live',
    nearLatest: false,
    userDroveLastScroll: false,
    initialLandingComplete: false,
    focusTarget: null,
    ...overrides,
  };
}

const following: TimelineScrollMode = { kind: 'followingLive' };
const reading: TimelineScrollMode = { kind: 'readingHistory' };
const initial: TimelineScrollMode = { kind: 'initialLive' };
const focused: TimelineScrollMode = { kind: 'focused', eventId: '$target' };

describe('nextScrollMode', () => {
  test('stays on the initial landing until it has settled', () => {
    expect(nextScrollMode(initial, signals())).toEqual(initial);
    expect(nextScrollMode(initial, signals({ nearLatest: true }))).toEqual(initial);
  });

  test('a user scroll away from the end ends the initial landing', () => {
    expect(nextScrollMode(initial, signals({ userDroveLastScroll: true }))).toEqual(reading);
  });

  test('a user scroll that stays at the end leaves the landing alone', () => {
    expect(
      nextScrollMode(initial, signals({ userDroveLastScroll: true, nearLatest: true }))
    ).toEqual(initial);
  });

  test('follows the end once the initial landing completes', () => {
    expect(nextScrollMode(initial, signals({ initialLandingComplete: true }))).toEqual(following);
  });

  test('starts reading history when the user scrolls away from the end', () => {
    expect(nextScrollMode(following, signals({ userDroveLastScroll: true }))).toEqual(reading);
  });

  test('a scroll the user did not drive does not stop following', () => {
    // Otherwise a programmatic scroll, which raises no gesture, would be read as
    // the user leaving the end.
    expect(nextScrollMode(following, signals())).toEqual(following);
  });

  test('returns to following when the user reaches the end again', () => {
    expect(
      nextScrollMode(reading, signals({ nearLatest: true, userDroveLastScroll: true }))
    ).toEqual(following);
  });

  test('reaching the end while reading history follows even without a gesture', () => {
    // Content shrinking under the viewport can put us at the end on its own.
    expect(nextScrollMode(reading, signals({ nearLatest: true }))).toEqual(following);
  });

  test('a permalink takes over from any mode', () => {
    for (const mode of [initial, following, reading]) {
      expect(nextScrollMode(mode, signals({ focusTarget: '$target' }))).toEqual(focused);
    }
  });

  test('a new permalink replaces the one being shown', () => {
    expect(nextScrollMode(focused, signals({ focusTarget: '$other' }))).toEqual({
      kind: 'focused',
      eventId: '$other',
    });
  });

  test('the same permalink does not restart the focus', () => {
    expect(nextScrollMode(focused, signals({ focusTarget: '$target' }))).toEqual(focused);
  });

  test('the smooth scroll onto a permalink does not drop the anchor', () => {
    // Centring the target can itself finish inside the end threshold, and
    // dropping the anchor there restarts the timeline at the present.
    expect(nextScrollMode(focused, signals({ nearLatest: true }))).toEqual(focused);
  });

  test('the user scrolling to the live end leaves the permalink', () => {
    expect(
      nextScrollMode(focused, signals({ nearLatest: true, userDroveLastScroll: true }))
    ).toEqual(following);
  });

  test('the end of a focused context is not the live end', () => {
    expect(nextScrollMode(reading, signals({ timelineMode: 'focused', nearLatest: true }))).toEqual(
      reading
    );
  });
});
