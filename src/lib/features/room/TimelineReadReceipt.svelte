<script lang="ts">
  import { onDestroy } from 'svelte';
  import { on } from 'svelte/events';

  import type { RoomTimeline } from '#lib/rooms/timeline.svelte.js';

  import { readReceiptEventId } from './timeline-format';

  const COALESCE_MS = 500;

  interface Props {
    timeline: RoomTimeline;
    /** The newest event whose row is fully scrolled past. */
    visibleEventId: string | null;
    onRead: (eventId: string) => Promise<void>;
  }

  let { timeline, visibleEventId, onRead }: Props = $props();
  let documentVisible = $state(true);
  let lastReadEventId: string | null = null;
  let readingEventId: string | null = null;
  let pendingEventId: string | null = null;
  let coalesceTimer: ReturnType<typeof setTimeout> | undefined;

  function send(eventId: string): void {
    readingEventId = eventId;
    void onRead(eventId)
      .then(() => {
        lastReadEventId = eventId;
      })
      .catch(() => {})
      .finally(() => {
        if (readingEventId === eventId) readingEventId = null;
        flush();
      });
  }

  function flush(): void {
    clearTimeout(coalesceTimer);
    coalesceTimer = undefined;
    const eventId = pendingEventId;
    if (!eventId || readingEventId !== null) return;
    pendingEventId = null;
    send(eventId);
  }

  $effect(() => {
    const updateVisibility = () => {
      documentVisible = document.visibilityState === 'visible';
      if (!documentVisible) flush();
    };
    updateVisibility();
    return on(document, 'visibilitychange', updateVisibility);
  });

  $effect(() => {
    if (timeline.mode.kind !== 'live') return;
    const eventId = readReceiptEventId(timeline.items, {
      visibleEventId,
      documentVisible,
      lastReadEventId,
    });
    if (!eventId || eventId === readingEventId) return;
    pendingEventId = eventId;
    if (coalesceTimer === undefined) coalesceTimer = setTimeout(flush, COALESCE_MS);
  });

  onDestroy(() => {
    clearTimeout(coalesceTimer);
  });
</script>
