export type TimelinePosition =
  | { kind: 'settling' }
  | { kind: 'pinned' }
  | { kind: 'anchored'; key: string; top: number }
  | { kind: 'focused'; eventId: string };

/** A press is not a scroll, and a context menu can hold one open indefinitely. */
export type Gesture = 'none' | 'press' | 'wheel' | 'touch' | 'keys' | 'autoscroll';

export type TimelineEvent =
  | { kind: 'items-changed'; prepended: boolean; appended: boolean }
  | { kind: 'viewport-resized'; previousHeight: number; height: number }
  | { kind: 'content-measured'; delta: number }
  | {
      kind: 'user-scrolled';
      timelineMode: 'live' | 'focused' | 'thread';
      nearLatest: boolean;
      /** The offset moved back through the timeline. */
      movedAway: boolean;
      gesture: Gesture;
      anchorKey: string | null;
      anchorTop: number;
    }
  | { kind: 'focus-requested'; eventId: string | null }
  | { kind: 'fill-finished'; unreadKey: string | null }
  | { kind: 'jump-to-latest' };

export function isNearLatest(
  viewport: Pick<HTMLElement, 'scrollHeight' | 'scrollTop' | 'clientHeight'>,
  threshold: number
): boolean {
  return viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= threshold;
}

export function initialPosition(focusEventId: string | null): TimelinePosition {
  return focusEventId === null ? { kind: 'settling' } : { kind: 'focused', eventId: focusEventId };
}

export function isScrolling(gesture: Gesture): boolean {
  return gesture !== 'none' && gesture !== 'press';
}

export function nextPosition(current: TimelinePosition, event: TimelineEvent): TimelinePosition {
  switch (event.kind) {
    case 'focus-requested':
      return event.eventId === null
        ? current.kind === 'focused'
          ? { kind: 'pinned' }
          : current
        : { kind: 'focused', eventId: event.eventId };

    case 'jump-to-latest':
      return { kind: 'pinned' };

    case 'fill-finished':
      if (current.kind !== 'settling') return current;
      return event.unreadKey === null
        ? { kind: 'pinned' }
        : { kind: 'anchored', key: event.unreadKey, top: 0 };

    case 'user-scrolled': {
      // The end of a permalink's loaded context is not the live end.
      if (event.timelineMode !== 'live') return current;
      // The band that counts as the end is wide enough to read a message
      // inside, so reading back within it is not an arrival at the end.
      if (event.nearLatest && !(event.movedAway && isScrolling(event.gesture))) {
        // The fill rescrolls to the end until it settles, so arriving there
        // proves nothing about the reader.
        if (current.kind === 'settling') return current;
        if (current.kind === 'focused' && !isScrolling(event.gesture)) return current;
        return { kind: 'pinned' };
      }
      if (!isScrolling(event.gesture)) return current;
      return event.anchorKey === null
        ? current
        : { kind: 'anchored', key: event.anchorKey, top: event.anchorTop };
    }

    case 'viewport-resized':
    case 'content-measured':
    case 'items-changed':
      return current;
  }
}
