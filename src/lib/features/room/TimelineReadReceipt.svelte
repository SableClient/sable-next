<script lang="ts">
  import type { RoomTimeline } from '$lib/rooms/timeline.svelte';

  import { readReceiptEventId } from './timeline-format';

  interface Props {
    timeline: RoomTimeline;
    focusEventId: string | null;
    initialAnchorComplete: boolean;
    nearLatest: boolean;
    onRead: (eventId: string) => Promise<void>;
  }

  let { timeline, focusEventId, initialAnchorComplete, nearLatest, onRead }: Props = $props();
  let documentVisible = $state(true);
  let lastReadEventId: string | null = null;
  let readingEventId: string | null = null;

  $effect(() => {
    const updateVisibility = () => {
      documentVisible = document.visibilityState === 'visible';
    };
    updateVisibility();
    document.addEventListener('visibilitychange', updateVisibility);
    return () => {
      document.removeEventListener('visibilitychange', updateVisibility);
    };
  });

  $effect(() => {
    if (timeline.mode.kind !== 'live') return;
    const eventId = readReceiptEventId(timeline.items, {
      focusEventId,
      initialAnchorComplete,
      nearLatest,
      documentVisible,
      lastReadEventId,
    });
    if (!eventId || eventId === readingEventId) return;
    readingEventId = eventId;
    void onRead(eventId)
      .then(() => {
        lastReadEventId = eventId;
      })
      .catch(() => {})
      .finally(() => {
        if (readingEventId === eventId) readingEventId = null;
      });
  });
</script>
