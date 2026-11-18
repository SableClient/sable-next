import { SvelteSet } from 'svelte/reactivity';

import type { RoomTimeline } from '#lib/rooms/timeline.svelte.js';

interface MentionsDependencies {
  timeline: () => Pick<RoomTimeline, 'items' | 'error' | 'loading'>;
  eventIds: () => readonly string[];
}

export class TimelineMentions {
  readonly #seen = new SvelteSet<string>();
  #target = $state<string | null>(null);
  readonly #deps: MentionsDependencies;
  readonly pending: string[];
  readonly jumping: boolean;

  constructor(deps: MentionsDependencies) {
    this.#deps = deps;
    this.pending = $derived(deps.eventIds().filter((eventId) => !this.#seen.has(eventId)));
    this.jumping = $derived.by(() => {
      const target = this.#target;
      if (target === null || this.#seen.has(target)) return false;
      const timeline = deps.timeline();
      return (
        timeline.error === null &&
        (timeline.loading || !timeline.items.some((item) => item.event_id === target))
      );
    });
  }

  markSeen(eventId: string): void {
    this.#seen.add(eventId);
  }

  next(isShown: (eventId: string) => boolean): string | null {
    if (this.jumping) return null;
    for (const eventId of this.pending) {
      // A loaded mention this timeline does not show can never reach the screen.
      if (
        this.#deps.timeline().items.some((item) => item.event_id === eventId) &&
        !isShown(eventId)
      ) {
        this.#seen.add(eventId);
        continue;
      }
      this.#target = eventId;
      return eventId;
    }
    return null;
  }
}
