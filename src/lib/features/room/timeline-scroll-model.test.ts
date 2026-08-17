import fc from 'fast-check';
import { describe, expect, test } from 'vitest';

import { nextScrollMode, type ScrollModeSignals } from './timeline-scroll-policy';
import { initialTimelineScrollMode, type TimelineScrollMode } from './timeline-scroll';

// The interleavings that break anchoring are the ones nobody writes by hand: a
// permalink resolving mid-load, or the end reached by content shrinking rather
// than by scrolling. So they are generated.
const signal = fc.record<ScrollModeSignals>({
  timelineMode: fc.constantFrom('live', 'focused'),
  nearLatest: fc.boolean(),
  userDroveLastScroll: fc.boolean(),
  initialLandingComplete: fc.boolean(),
  focusTarget: fc.option(fc.constantFrom('$a', '$b'), { nil: null }),
});

function run(start: TimelineScrollMode, steps: readonly ScrollModeSignals[]): TimelineScrollMode[] {
  const seen: TimelineScrollMode[] = [];
  let mode = start;
  for (const step of steps) {
    mode = nextScrollMode(mode, step);
    seen.push(mode);
  }
  return seen;
}

const start = fc.constantFrom<TimelineScrollMode>(
  { kind: 'initialLive' },
  { kind: 'followingLive' },
  { kind: 'readingHistory' },
  { kind: 'focused', eventId: '$a' }
);

describe('scroll mode policy', () => {
  test('only a user gesture can start reading history', () => {
    fc.assert(
      fc.property(start, fc.array(signal, { maxLength: 24 }), (from, steps) => {
        let mode = from;
        for (const step of steps) {
          const next = nextScrollMode(mode, step);
          if (next.kind === 'readingHistory' && mode.kind !== 'readingHistory') {
            expect(step.userDroveLastScroll).toBe(true);
          }
          mode = next;
        }
      })
    );
  });

  test('the initial landing is never returned to', () => {
    fc.assert(
      fc.property(start, fc.array(signal, { minLength: 1, maxLength: 24 }), (from, steps) => {
        const seen = run(from, steps);
        if (from.kind === 'initialLive') {
          // It may stay there, but never come back after leaving.
          const left = seen.findIndex((mode) => mode.kind !== 'initialLive');
          if (left >= 0) {
            expect(seen.slice(left).some((mode) => mode.kind === 'initialLive')).toBe(false);
          }
        } else {
          expect(seen.some((mode) => mode.kind === 'initialLive')).toBe(false);
        }
      })
    );
  });

  test('the initial landing is only left once it has completed', () => {
    fc.assert(
      fc.property(fc.array(signal, { maxLength: 24 }), (steps) => {
        let mode: TimelineScrollMode = { kind: 'initialLive' };
        for (const step of steps) {
          const next = nextScrollMode(mode, step);
          if (mode.kind === 'initialLive' && next.kind !== 'initialLive') {
            // A permalink, a completed landing, or the reader scrolling away
            // from the end, which the landing must not fight.
            expect(
              step.initialLandingComplete ||
                step.focusTarget !== null ||
                (step.userDroveLastScroll && !step.nearLatest)
            ).toBe(true);
          }
          mode = next;
        }
      })
    );
  });

  test('a focus target always ends up focused on that target', () => {
    fc.assert(
      fc.property(start, signal, (from, step) => {
        const next = nextScrollMode(from, { ...step, focusTarget: '$b' });
        expect(next).toEqual({ kind: 'focused', eventId: '$b' });
      })
    );
  });

  test('a focused timeline never follows the end of its loaded context', () => {
    // Reaching the bottom of a permalink context is not reaching the present.
    fc.assert(
      fc.property(fc.array(signal, { maxLength: 24 }), (steps) => {
        let mode: TimelineScrollMode = { kind: 'focused', eventId: '$a' };
        for (const step of steps) {
          const next = nextScrollMode(mode, {
            ...step,
            timelineMode: 'focused',
            focusTarget: null,
          });
          expect(next.kind).not.toBe('followingLive');
          mode = next;
        }
      })
    );
  });

  test('the policy is deterministic', () => {
    fc.assert(
      fc.property(start, fc.array(signal, { maxLength: 16 }), (from, steps) => {
        expect(run(from, steps)).toEqual(run(from, steps));
      })
    );
  });

  test('a mount-time permalink starts focused, and nothing else does', () => {
    fc.assert(
      fc.property(fc.option(fc.constant('$a'), { nil: null }), (focusEventId) => {
        const mode = initialTimelineScrollMode(focusEventId);
        expect(mode.kind).toBe(focusEventId === null ? 'initialLive' : 'focused');
      })
    );
  });
});
