<script lang="ts">
  import { onDestroy } from 'svelte';

  import { windowActivity } from '#lib/platform/window-activity.js';
  import type { RoomTimeline } from '#lib/rooms/timeline.svelte.js';

  import { readReceiptEventId } from './timeline-format';

  const COALESCE_MS = 500;
  const RETRY_MS = [1_000, 5_000, 30_000];

  interface Props {
    timeline: RoomTimeline;
    /** The newest event whose row is fully scrolled past. */
    visibleEventId: string | null;
    atLatest?: boolean;
    enabled?: boolean;
    onRead: (eventId: string) => Promise<void>;
  }

  let { timeline, visibleEventId, atLatest = false, enabled = true, onRead }: Props = $props();
  let historical = $derived(timeline.mode.kind === 'focused' && !atLatest);
  let active = $derived(windowActivity.active);
  let lastReadEventId: string | null = null;
  let readingEventId: string | null = null;
  let pendingEventId: string | null = null;
  let coalesceTimer: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;

  function send(eventId: string): void {
    readingEventId = eventId;
    void onRead(eventId)
      .then(() => {
        lastReadEventId = eventId;
        failures = 0;
      })
      .catch(() => {
        failures += 1;
        pendingEventId ??= eventId;
      })
      .finally(() => {
        if (readingEventId === eventId) readingEventId = null;
        if (failures === 0) flush();
        else coalesceTimer ??= setTimeout(flush, RETRY_MS[Math.min(failures, RETRY_MS.length) - 1]);
      });
  }

  function flush(): void {
    clearTimeout(coalesceTimer);
    coalesceTimer = undefined;
    if (historical || !enabled) {
      pendingEventId = null;
      return;
    }
    const eventId = pendingEventId;
    if (!eventId || readingEventId !== null) return;
    // Queued receipts were already visible, even if the tab is now hidden.
    if (
      readReceiptEventId(timeline.items, {
        visibleEventId: eventId,
        documentVisible: true,
        lastReadEventId,
      }) !== eventId
    ) {
      pendingEventId = null;
      return;
    }
    pendingEventId = null;
    send(eventId);
  }

  $effect(() => {
    if (!active) flush();
    if (historical || !enabled) {
      pendingEventId = null;
      clearTimeout(coalesceTimer);
      coalesceTimer = undefined;
      return;
    }
    const eventId = readReceiptEventId(timeline.items, {
      visibleEventId,
      documentVisible: active,
      lastReadEventId: pendingEventId ?? readingEventId ?? lastReadEventId,
    });
    if (!eventId || eventId === readingEventId) return;
    pendingEventId = eventId;
    if (coalesceTimer === undefined) coalesceTimer = setTimeout(flush, COALESCE_MS);
  });

  onDestroy(() => {
    pendingEventId = null;
    clearTimeout(coalesceTimer);
  });
</script>
