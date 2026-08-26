<script lang="ts">
  import { untrack, type ComponentProps } from 'svelte';

  import { Bookmarks, provideBookmarks, type BookmarkCommands } from './bookmarks.svelte.js';
  import {
    PinnedEvents,
    providePinnedEvents,
    type PinnedEventCommands,
  } from './pinned-events.svelte.js';
  import TimelineItem from './TimelineItem.svelte';

  interface Props {
    core: PinnedEventCommands & BookmarkCommands;
    item: ComponentProps<typeof TimelineItem>;
  }

  let { core, item }: Props = $props();

  providePinnedEvents(new PinnedEvents(untrack(() => core)));
  provideBookmarks(new Bookmarks(untrack(() => core)));
</script>

<TimelineItem {...item} />
