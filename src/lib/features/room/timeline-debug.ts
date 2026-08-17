import type { RoomTimeline } from '$lib/rooms/timeline.svelte';

export interface TimelineDebugSample {
  time: number;
  scrollTop: number;
  scrollHeight: number;
  contentDelta: number;
  distanceFromEnd: number;
  frameDuration: number;
  maxFrameDuration: number;
  frameDelta: number;
  maxFrameDelta: number;
  anchorKey: string | null;
  anchorTop: number | null;
  visualDelta: number;
  maxVisualDelta: number;
  /** Left over after the anchor last corrected; null when it had nothing to hold. */
  anchorResidual: number | null;
  maxAnchorResidual: number;
  /** Which anchor owns the position, so an uncorrected shift can be attributed. */
  anchorGuard: 'hold' | 'rolling' | 'none';
  /** The last scroll the anchor wrote, so a jump in the trace names its author. */
  anchorCorrection: { by: string; delta: number; key: string | null } | null;
  firstVirtualIndex: number | null;
  lastVirtualIndex: number | null;
  isScrolling: boolean;
  scrollMode: string;
  backwardPagination: RoomTimeline['backwardPagination'];
}

export interface TimelineDebugVirtualItem {
  index: number;
  key: string | number | bigint;
  start: number;
  end: number;
}

export interface TimelineDebugVirtualizer {
  getVirtualItems(): readonly TimelineDebugVirtualItem[];
  isScrolling: boolean;
}

export function timelineDebugEnabled(): boolean {
  return (
    import.meta.env.DEV &&
    typeof window !== 'undefined' &&
    new URLSearchParams(window.location.search).has('timelineDebug')
  );
}

export class TimelineDebugRecorder {
  private readonly samples: TimelineDebugSample[] = [];

  add(sample: TimelineDebugSample): void {
    this.samples.push(sample);
    if (this.samples.length > 1_800) this.samples.shift();
  }

  latest(): TimelineDebugSample | null {
    return this.samples.at(-1) ?? null;
  }

  async copyTrace(): Promise<void> {
    const first = this.samples[0];
    const transitions = this.samples.filter((sample, index, samples) => {
      if (index === 0) return true;
      const previous = samples[index - 1];
      return (
        Math.abs(sample.frameDelta) >= 100 ||
        Math.abs(sample.contentDelta) >= 100 ||
        sample.frameDuration >= 24 ||
        Math.abs(sample.visualDelta) >= 16 ||
        Math.abs(sample.anchorResidual ?? 0) >= 2 ||
        sample.scrollMode !== previous.scrollMode ||
        sample.backwardPagination !== previous.backwardPagination ||
        sample.isScrolling !== previous.isScrolling
      );
    });
    const largestFrame = this.samples.reduce<TimelineDebugSample | null>(
      (largest, sample) =>
        !largest || Math.abs(sample.frameDelta) > Math.abs(largest.frameDelta) ? sample : largest,
      null
    );
    const slowestFrame = this.samples.reduce<TimelineDebugSample | null>(
      (slowest, sample) =>
        !slowest || sample.frameDuration > slowest.frameDuration ? sample : slowest,
      null
    );
    await navigator.clipboard.writeText(
      JSON.stringify(
        {
          samples: this.samples.length,
          start: first,
          end: this.samples.at(-1),
          largestFrame,
          slowestFrame,
          transitions: transitions.slice(-40),
        },
        null,
        2
      )
    );
  }
}

export function timelineDebugSnapshot(
  viewport: HTMLDivElement | null,
  virtualizer: TimelineDebugVirtualizer,
  scrollMode: string
): object | null {
  if (!viewport) return null;
  const viewportRect = viewport.getBoundingClientRect();
  let anchor: object | null = null;
  for (const item of viewport.querySelectorAll<HTMLElement>('.item')) {
    const rect = item.getBoundingClientRect();
    const top = rect.top - viewportRect.top;
    const bottom = rect.bottom - viewportRect.top;
    if (top >= 0 && bottom <= viewport.clientHeight) {
      anchor = {
        id: item.dataset.itemId ?? null,
        eventId: item.dataset.eventId ?? null,
        index: item.dataset.index ?? null,
        top,
        bottom,
      };
      break;
    }
  }
  const virtualItems = virtualizer.getVirtualItems();
  return {
    scrollTop: viewport.scrollTop,
    scrollHeight: viewport.scrollHeight,
    clientHeight: viewport.clientHeight,
    firstVirtualIndex: virtualItems[0]?.index ?? null,
    lastVirtualIndex: virtualItems.at(-1)?.index ?? null,
    anchor,
    scrollMode,
  };
}
