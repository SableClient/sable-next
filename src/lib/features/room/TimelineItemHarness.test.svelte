<script lang="ts">
  import { untrack, type ComponentProps } from 'svelte';

  import {
    PinnedEvents,
    providePinnedEvents,
    type PinnedEventCommands,
  } from './pinned-events.svelte.js';
  import TimelineItem from './TimelineItem.svelte';

  interface Props {
    core: PinnedEventCommands;
    item: ComponentProps<typeof TimelineItem>;
  }

  let { core, item }: Props = $props();

  providePinnedEvents(new PinnedEvents(untrack(() => core)));
</script>

<TimelineItem {...item} />
