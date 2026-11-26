<script lang="ts">
  import { untrack, type ComponentProps } from 'svelte';

  import { Bookmarks, provideBookmarks } from '#lib/rooms/bookmarks.svelte.js';
  import { PinnedEvents, providePinnedEvents } from './pinned-events.svelte.js';
  import TimelineList from './TimelineList.svelte';

  interface Props {
    list: ComponentProps<typeof TimelineList>;
  }

  let { list }: Props = $props();
  let followingLive = $state(false);
  let timelineList = $state<TimelineList>();

  $effect(() => {
    list.followingLive = followingLive;
  });

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

<TimelineList bind:this={timelineList} {...list} bind:followingLive />
<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="harness-composer"
  onfocusin={(event) => timelineList?.composerFocused(event)}
  onkeydown={(event) => timelineList?.composerKeydown(event)}
>
  <textarea aria-label="composer"></textarea>
</div>
