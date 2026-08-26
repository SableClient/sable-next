<script lang="ts">
  import { untrack, type ComponentProps } from 'svelte';

  import { Bookmarks, provideBookmarks } from './bookmarks.svelte.js';
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
  provideBookmarks(
    new Bookmarks(
      untrack(() => ({
        bookmarks: () => Promise.resolve([]),
        setBookmark: () => Promise.resolve(false),
      }))
    )
  );
</script>

<TimelineList {...list} />
