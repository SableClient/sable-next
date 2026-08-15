export type TimelineScrollMode =
  | { kind: 'initialLive' }
  | { kind: 'followingLive' }
  | { kind: 'readingHistory' }
  | { kind: 'focused'; eventId: string };

export function initialTimelineScrollMode(focusEventId: string | null): TimelineScrollMode {
  return focusEventId === null
    ? { kind: 'initialLive' }
    : { kind: 'focused', eventId: focusEventId };
}

export function isNearLatest(
  viewport: Pick<HTMLElement, 'scrollHeight' | 'scrollTop' | 'clientHeight'>,
  threshold: number
): boolean {
  return viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= threshold;
}
