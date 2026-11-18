import type { RoomTimeline } from '#lib/rooms/timeline.svelte.js';
import type { TimelineWindowState } from '#lib/timeline/timeline-window.js';

import { latestEventId } from './timeline-format';
import type { RowValue } from './timeline-rows.svelte.js';

interface ReadPositionDependencies {
  roomId: string | null;
  timeline: () => Pick<RoomTimeline, 'items'>;
  windowState: () => TimelineWindowState<RowValue>;
  canRead: () => boolean;
  onFullyRead: () => ((roomId: string, eventId: string) => void) | undefined;
}

export class TimelineReadPosition {
  #upTo: string | null = null;
  #fullyReadAt: string | null = null;
  readonly #deps: ReadPositionDependencies;
  readonly eventId: string | null;

  constructor(deps: ReadPositionDependencies) {
    this.#deps = deps;
    this.eventId = $derived.by(() => {
      if (!deps.canRead()) return null;
      const windowState = deps.windowState();
      if (windowState.pinned) {
        return (
          latestEventId(deps.timeline().items) ??
          latestEventId(windowState.rows.map((row) => row.value.item))
        );
      }
      if (windowState.lastFullyVisible === null) return null;
      for (let index = windowState.rows.length - 1; index >= 0; index -= 1) {
        const row = windowState.rows[index];
        if (row.index <= windowState.lastFullyVisible && row.value.item.event_id)
          return row.value.item.event_id;
      }
      return null;
    });
  }

  advance(eventId: string): void {
    this.#upTo = eventId;
  }

  markFullyRead(eventId: string): void {
    this.#fullyReadAt = eventId;
  }

  settle(): void {
    const onFullyRead = this.#deps.onFullyRead();
    if (
      !this.#deps.roomId ||
      !onFullyRead ||
      this.#upTo === null ||
      this.#upTo === this.#fullyReadAt
    )
      return;
    this.#fullyReadAt = this.#upTo;
    onFullyRead(this.#deps.roomId, this.#upTo);
  }
}
