import type { TimelineScrollMode } from './timeline-scroll';

export interface ScrollModeSignals {
  readonly timelineMode: 'live' | 'focused';
  readonly nearLatest: boolean;
  readonly userDroveLastScroll: boolean;
  readonly initialLandingComplete: boolean;
  readonly focusTarget: string | null;
}

export function nextScrollMode(
  current: TimelineScrollMode,
  signals: ScrollModeSignals
): TimelineScrollMode {
  if (
    signals.focusTarget !== null &&
    (current.kind !== 'focused' || current.eventId !== signals.focusTarget)
  ) {
    return { kind: 'focused', eventId: signals.focusTarget };
  }

  if (current.kind === 'initialLive') {
    // The landing rescrolls to the end until it settles, dragging back a reader
    // who scrolls up while it runs.
    if (signals.userDroveLastScroll && !signals.nearLatest) return { kind: 'readingHistory' };
    return signals.initialLandingComplete ? { kind: 'followingLive' } : current;
  }

  if (signals.timelineMode !== 'live') return current;

  if (signals.nearLatest) {
    if (current.kind === 'followingLive') return current;
    if (current.kind === 'focused' && !signals.userDroveLastScroll) return current;
    return { kind: 'followingLive' };
  }

  if (current.kind !== 'readingHistory' && signals.userDroveLastScroll) {
    return { kind: 'readingHistory' };
  }
  return current;
}
