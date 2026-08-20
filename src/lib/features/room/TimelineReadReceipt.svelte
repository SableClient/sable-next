<script lang="ts">
  import { on } from 'svelte/events';

  import type { RoomTimeline } from '#lib/rooms/timeline.svelte.js';

  import { readReceiptEventId } from './timeline-format';

  interface Props {
    timeline: RoomTimeline;
    followingLive: boolean;
    nearLatest: boolean;
    onRead: (eventId: string) => Promise<void>;
  }

  let { timeline, followingLive, nearLatest, onRead }: Props = $props();
  let documentVisible = $state(true);
  let lastReadEventId: string | null = null;
  let readingEventId: string | null = null;

  $effect(() => {
    const updateVisibility = () => {
      documentVisible = document.visibilityState === 'visible';
    };
    updateVisibility();
    return on(document, 'visibilitychange', updateVisibility);
  });

  $effect(() => {
    if (timeline.mode.kind !== 'live') return;
    const eventId = readReceiptEventId(timeline.items, {
      followingLive,
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
