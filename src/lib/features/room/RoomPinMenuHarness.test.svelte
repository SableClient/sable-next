<script lang="ts">
  import type { ComponentProps } from 'svelte';

  import { useCoreClient } from '#lib/core/context.js';
  import { Bookmarks, provideBookmarks } from '#lib/rooms/bookmarks.svelte.js';
  import TooltipProvider from '#lib/ui/primitives/TooltipProvider.svelte';

  import { EventItems, provideEventItems } from './messages/event-items.svelte.js';
  import { RoomScopes, provideRoomScopes } from './messages/message-scope.svelte.js';
  import MediaViewer from '#lib/ui/media/MediaViewer.svelte';
  import RoomPinMenu from './RoomPinMenu.svelte';
  import { mediaViewerState } from '#lib/ui/media/media-viewer-state.svelte.js';

  let { menu, revision }: { menu: ComponentProps<typeof RoomPinMenu>; revision?: string | null } =
    $props();
  let open = $state(false);
  const menuProps = $derived(menu);
  const core = useCoreClient();
  provideEventItems(new EventItems(core.rpc.timeline, () => core.session?.account_id ?? null));
  provideRoomScopes(new RoomScopes(core));
  provideBookmarks(new Bookmarks(core.rpc.account));
</script>

<TooltipProvider>
  <RoomPinMenu {...menuProps} {revision} bind:open />
  {#if mediaViewerState.eventId}
    <MediaViewer />
  {/if}
</TooltipProvider>
