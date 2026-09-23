<script lang="ts">
  import type { ComponentProps } from 'svelte';

  import { Bookmarks, provideBookmarks } from './bookmarks.svelte.js';
  import { PinnedEvents, providePinnedEvents } from './pinned-events.svelte.js';
  import ThreadPanel from './ThreadPanel.svelte';

  interface Props {
    panel: ComponentProps<typeof ThreadPanel>;
  }

  let { panel }: Props = $props();

  providePinnedEvents(
    new PinnedEvents({
      pinnedEvents: () => Promise.resolve([]),
      setPinned: () => Promise.resolve([]),
    })
  );
  provideBookmarks(
    new Bookmarks({
      bookmarks: () => Promise.resolve([]),
      setBookmark: () => Promise.resolve(false),
    })
  );
</script>

<ThreadPanel {...panel} />
