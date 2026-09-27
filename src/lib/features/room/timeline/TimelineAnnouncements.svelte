<script lang="ts">
  import { untrack } from 'svelte';
  import type { TimelineItemView } from '#src/generated/protocol';
  import type { RoomTimeline } from '#lib/rooms/timeline.svelte.js';
  import { i18n } from '#lib/i18n.js';
  import { TimelineArrivals } from '#lib/timeline/timeline-arrivals.js';

  let {
    timeline,
    visibleItems,
  }: { timeline: RoomTimeline; visibleItems: readonly TimelineItemView[] } = $props();
  const arrivals = new TimelineArrivals();
  let count = $state(0);
  let sequence = $state(0);

  $effect(() => {
    const items = timeline.items;
    const enabled = timeline.hasSnapshot && timeline.mode.kind !== 'focused';
    const paginating = timeline.forwardPagination === 'loading';
    untrack(() => {
      if (!enabled) {
        arrivals.reset();
        count = 0;
        return;
      }
      const visible = new Set(visibleItems.map((item) => item.id));
      const incoming = arrivals.update(items).filter((item) => visible.has(item.id));
      if (incoming.length === 0 || paginating) return;
      count = incoming.length;
      sequence += 1;
    });
  });
</script>

<div class="announcements" data-timeline-announcements aria-live="polite" aria-atomic="true">
  {#key sequence}{#if count > 0}{$i18n.t('timeline.newMessages', { count })}{/if}{/key}
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
