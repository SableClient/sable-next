<script lang="ts">
  import { untrack, type ComponentProps } from 'svelte';

  import { PinnedEvents, providePinnedEvents } from './pinned-events.svelte.js';
  import TimelineList from './TimelineList.svelte';

  interface Props {
    list: ComponentProps<typeof TimelineList>;
  }

  let { list }: Props = $props();

  providePinnedEvents(
    new PinnedEvents(
      untrack(() => ({
        pinnedEvents: () => Promise.resolve([]),
        setPinned: () => Promise.resolve([]),
      }))
    )
  );
</script>

<TimelineList {...list} />
