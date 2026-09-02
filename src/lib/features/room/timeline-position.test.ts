import fc from 'fast-check';
import { describe, expect, test } from 'vitest';

import {
  initialPosition,
  isNearLatest,
  isScrolling,
  nextPosition,
  type TimelineEvent,
  type TimelinePosition,
} from './timeline-position';

const settling: TimelinePosition = { kind: 'settling' };
const pinned: TimelinePosition = { kind: 'pinned' };
const anchored: TimelinePosition = { kind: 'anchored', key: 'event:$a', top: 40 };
const focused: TimelinePosition = { kind: 'focused', eventId: '$target' };

const timelineMode = fc.constantFrom<'live' | 'focused'>('live', 'focused');

const position = fc.oneof(
  fc.constant(settling),
  fc.constant(pinned),
  fc.record({
    kind: fc.constant('anchored' as const),
    key: fc.string({ minLength: 1 }),
    top: fc.integer({ min: -500, max: 500 }),
  }),
  fc.record({ kind: fc.constant('focused' as const), eventId: fc.string({ minLength: 1 }) })
);

const event = fc.oneof(
  fc.record({
    kind: fc.constant('items-changed' as const),
    prepended: fc.boolean(),
    appended: fc.boolean(),
  }),
  fc.record({
    kind: fc.constant('viewport-resized' as const),
    previousHeight: fc.integer({ min: 0, max: 2000 }),
    height: fc.integer({ min: 0, max: 2000 }),
  }),
  fc.record({
    kind: fc.constant('content-measured' as const),
    delta: fc.integer({ min: -2000, max: 2000 }),
  }),
  fc.record({
    kind: fc.constant('user-scrolled' as const),
    timelineMode,
    nearLatest: fc.boolean(),
    movedAway: fc.boolean(),
    byReader: fc.boolean(),
    anchorKey: fc.option(fc.string({ minLength: 1 }), { nil: null }),
    anchorTop: fc.integer({ min: -500, max: 500 }),
  }),
  fc.record({
    kind: fc.constant('focus-requested' as const),
    eventId: fc.option(fc.string({ minLength: 1 }), { nil: null }),
  }),
  fc.record({
    kind: fc.constant('fill-finished' as const),
    unreadKey: fc.option(fc.string({ minLength: 1 }), { nil: null }),
  }),
  fc.constant<TimelineEvent>({ kind: 'jump-to-latest' })
);

describe('nextPosition', () => {
  test('a focus request wins over everything', () => {
    for (const from of [settling, pinned, anchored, focused]) {
      expect(nextPosition(from, { kind: 'focus-requested', eventId: '$next' })).toEqual({
        kind: 'focused',
        eventId: '$next',
      });
    }
  });

  test('clearing the focus target returns to the newest event', () => {
    expect(nextPosition(focused, { kind: 'focus-requested', eventId: null })).toEqual(pinned);
    expect(nextPosition(anchored, { kind: 'focus-requested', eventId: null })).toEqual(anchored);
  });

  test('the opening fill hands over once it is done', () => {
    expect(nextPosition(settling, { kind: 'fill-finished', unreadKey: null })).toEqual(pinned);
    expect(nextPosition(anchored, { kind: 'fill-finished', unreadKey: null })).toEqual(anchored);
  });

  test('the opening lands on the first unread rather than the newest event', () => {
    expect(nextPosition(settling, { kind: 'fill-finished', unreadKey: 'item:marker' })).toEqual({
      kind: 'anchored',
      key: 'item:marker',
      top: 0,
    });
  });

  test('scrolling away from the end anchors on the visible row', () => {
    expect(
      nextPosition(pinned, {
        kind: 'user-scrolled',
        timelineMode: 'live',
        nearLatest: false,
        movedAway: true,
        byReader: true,
        anchorKey: 'event:$b',
        anchorTop: 12,
      })
    ).toEqual({ kind: 'anchored', key: 'event:$b', top: 12 });
  });

  test('reading back inside the band does not snap to the newest event', () => {
    expect(
      nextPosition(pinned, {
        kind: 'user-scrolled',
        timelineMode: 'live',
        nearLatest: true,
        movedAway: true,
        byReader: true,
        anchorKey: 'event:$b',
        anchorTop: 12,
      })
    ).toEqual({ kind: 'anchored', key: 'event:$b', top: 12 });
  });

  test('scrolling back to the end pins again', () => {
    expect(
      nextPosition(anchored, {
        kind: 'user-scrolled',
        timelineMode: 'live',
        nearLatest: true,
        movedAway: false,
        byReader: true,
        anchorKey: 'event:$b',
        anchorTop: 12,
      })
    ).toEqual(pinned);
  });
});

describe('properties', () => {
  test('an offset the view wrote itself never moves the position away from the end', () => {
    fc.assert(
      fc.property(
        position,
        fc.boolean(),
        fc.option(fc.string({ minLength: 1 }), { nil: null }),
        (from, movedAway, anchorKey) => {
          expect(
            nextPosition(from, {
              kind: 'user-scrolled',
              timelineMode: 'live',
              nearLatest: false,
              movedAway,
              byReader: false,
              anchorKey,
              anchorTop: 0,
            })
          ).toEqual(from);
        }
      )
    );
  });

  test('a resize never changes where the viewport wants to be', () => {
    fc.assert(
      fc.property(
        position,
        fc.integer({ min: 0, max: 2000 }),
        fc.integer({ min: 0, max: 2000 }),
        (from, previousHeight, height) => {
          expect(nextPosition(from, { kind: 'viewport-resized', previousHeight, height })).toEqual(
            from
          );
        }
      )
    );
  });

  test('a prepend keeps the anchored row and its offset', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1 }), fc.integer(), fc.boolean(), (key, top, appended) => {
        expect(
          nextPosition(
            { kind: 'anchored', key, top },
            { kind: 'items-changed', prepended: true, appended }
          )
        ).toEqual({ kind: 'anchored', key, top });
      })
    );
  });

  test('settling is left only by a focus target, its completion, or reading away', () => {
    fc.assert(
      fc.property(event, (next) => {
        const after = nextPosition(settling, next);
        if (after.kind === 'settling') return;
        if (next.kind === 'user-scrolled') {
          expect(next.byReader && (!next.nearLatest || next.movedAway)).toBe(true);
          return;
        }
        expect(['focus-requested', 'fill-finished', 'jump-to-latest']).toContain(next.kind);
      })
    );
  });

  test('settling is never ended by arriving near the end on its own', () => {
    fc.assert(
      fc.property(fc.boolean(), (byReader) => {
        expect(
          nextPosition(settling, {
            kind: 'user-scrolled',
            timelineMode: 'live',
            nearLatest: true,
            movedAway: false,
            byReader,
            anchorKey: 'event:$a',
            anchorTop: 0,
          })
        ).toEqual(settling);
      })
    );
  });

  test('the landing is never returned to', () => {
    fc.assert(
      fc.property(position, event, (from, next) => {
        if (from.kind === 'settling') return;
        expect(nextPosition(from, next).kind).not.toBe('settling');
      })
    );
  });

  test('reaching the live end resumes following however the offset got there', () => {
    fc.assert(
      fc.property(fc.boolean(), (byReader) => {
        expect(
          nextPosition(anchored, {
            kind: 'user-scrolled',
            timelineMode: 'live',
            nearLatest: true,
            movedAway: false,
            byReader,
            anchorKey: 'event:$a',
            anchorTop: 0,
          })
        ).toEqual(pinned);
      })
    );
  });

  test('a self-written offset that moves back inside the band does not re-pin', () => {
    expect(
      nextPosition(anchored, {
        kind: 'user-scrolled',
        timelineMode: 'live',
        nearLatest: true,
        movedAway: true,
        byReader: false,
        anchorKey: 'event:$a',
        anchorTop: 0,
      })
    ).toEqual(anchored);
  });

  test('a self-written offset keeps a focused context inside the band', () => {
    expect(
      nextPosition(focused, {
        kind: 'user-scrolled',
        timelineMode: 'live',
        nearLatest: true,
        movedAway: false,
        byReader: false,
        anchorKey: 'event:$a',
        anchorTop: 0,
      })
    ).toEqual(focused);
  });

  test("a permalink's own end is not the live end", () => {
    fc.assert(
      fc.property(position, fc.boolean(), fc.boolean(), (from, byReader, nearLatest) => {
        expect(
          nextPosition(from, {
            kind: 'user-scrolled',
            timelineMode: 'focused',
            nearLatest,
            movedAway: false,
            byReader,
            anchorKey: 'event:$a',
            anchorTop: 0,
          })
        ).toEqual(from);
      })
    );
  });

  test('the same position and event always give the same answer', () => {
    fc.assert(
      fc.property(position, event, (from, next) => {
        expect(nextPosition(from, next)).toEqual(nextPosition(from, next));
      })
    );
  });

  test('every event leaves a defined position', () => {
    fc.assert(
      fc.property(position, event, (from, next) => {
        expect(['settling', 'pinned', 'anchored', 'focused']).toContain(
          nextPosition(from, next).kind
        );
      })
    );
  });
});

describe('initialPosition', () => {
  test('a permalink opens focused, everything else settles first', () => {
    expect(initialPosition(null)).toEqual(settling);
    expect(initialPosition('$target')).toEqual(focused);
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

describe('isScrolling', () => {
  test('only movement counts', () => {
    expect(isScrolling('none')).toBe(false);
    expect(isScrolling('press')).toBe(false);
    expect(isScrolling('wheel')).toBe(true);
    expect(isScrolling('touch')).toBe(true);
    expect(isScrolling('keys')).toBe(true);
  });
});

describe('autoscroll is a scrolling gesture', () => {
  test('isScrolling accepts it and rejects a plain press', () => {
    expect(isScrolling('autoscroll')).toBe(true);
    expect(isScrolling('press')).toBe(false);
  });
});

describe('the reader, not the device, leaves follow mode', () => {
  test('a scrollbar drag reading back anchors like a wheel notch', () => {
    expect(
      nextPosition(pinned, {
        kind: 'user-scrolled',
        timelineMode: 'live',
        nearLatest: false,
        movedAway: true,
        byReader: true,
        anchorKey: 'event:$a',
        anchorTop: 40,
      })
    ).toEqual({ kind: 'anchored', key: 'event:$a', top: 40 });
  });

  test('it cannot unpin without moving away', () => {
    expect(
      nextPosition(pinned, {
        kind: 'user-scrolled',
        timelineMode: 'live',
        nearLatest: true,
        movedAway: false,
        byReader: true,
        anchorKey: 'event:$a',
        anchorTop: 40,
      })
    ).toEqual(pinned);
  });
});
