<script lang="ts">
  import type { ComponentProps } from 'svelte';

  import { Bookmarks, provideBookmarks } from '#lib/rooms/bookmarks.svelte.js';
  import TooltipProvider from '#lib/ui/primitives/TooltipProvider.svelte';
  import { PinnedEvents, providePinnedEvents } from '../timeline/pinned-events.svelte.js';
  import ThreadView from './ThreadView.svelte';

  interface Props {
    panel: ComponentProps<typeof ThreadView>;
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

<TooltipProvider>
  <ThreadView {...panel} />
</TooltipProvider>
