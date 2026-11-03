<script lang="ts">
  import { untrack } from 'svelte';
  import type { TimelineItemView } from '#src/generated/protocol';
  import type { RoomTimeline } from '#lib/rooms/timeline.svelte.js';
  import { i18n } from '#lib/i18n.js';
  import { TimelineArrivals } from '#lib/timeline/timeline-arrivals.js';
  import { arrivalAnnouncement } from '#lib/timeline/timeline-announcement.js';

  let {
    timeline,
    visibleItems,
    atLiveEdge = false,
  }: {
    timeline: RoomTimeline;
    visibleItems: readonly TimelineItemView[];
    atLiveEdge?: boolean;
  } = $props();
  const arrivals = new TimelineArrivals();
  let text = $state('');
  let sequence = $state(0);

  $effect(() => {
    const items = timeline.items;
    const enabled = timeline.hasSnapshot && timeline.mode.kind !== 'focused';
    const paginating = timeline.forwardPagination === 'loading';
    untrack(() => {
      if (!enabled) {
        arrivals.reset();
        text = '';
        return;
      }
      const visible = new Set(visibleItems.map((item) => item.id));
      const incoming = arrivals.update(items).filter((item) => visible.has(item.id));
      if (incoming.length === 0 || paginating) return;
      text = arrivalAnnouncement(incoming, atLiveEdge, i18n.t);
      sequence += 1;
    });
  });
</script>

<div class="announcements" data-timeline-announcements aria-live="polite" aria-atomic="true">
  {#key sequence}{text}{/key}
</div>

<style>
  .announcements {
    clip-path: inset(50%);
    height: 1px;
    overflow: hidden;
    position: absolute;
    white-space: nowrap;
    width: 1px;
  }
</style>
