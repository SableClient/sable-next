<script lang="ts">
  import type { ComponentProps } from 'svelte';

  import { useCoreClient } from '#lib/core/context.js';
  import { Bookmarks, provideBookmarks } from '#lib/rooms/bookmarks.svelte.js';
  import TooltipProvider from '#lib/ui/primitives/TooltipProvider.svelte';

  import { EventItems, provideEventItems } from './messages/event-items.svelte.js';
  import { RoomScopes, provideRoomScopes } from './messages/message-scope.svelte.js';
  import MediaViewer from '#lib/ui/media/MediaViewer.svelte';
  import RoomPinMenu from './RoomPinMenu.svelte';
  import { RoomPins, provideRoomPins } from './room-pins.svelte.js';
  import { mediaViewerState } from '#lib/ui/media/media-viewer-state.svelte.js';

  let { menu, revision }: { menu: ComponentProps<typeof RoomPinMenu>; revision?: string | null } =
    $props();
  let open = $state(false);
  const menuProps = $derived(menu);
  const core = useCoreClient();
  const eventItems = new EventItems(core.rpc.timeline, () => core.session?.account_id ?? null);
  provideEventItems(eventItems);
  const pins = new RoomPins(core.rpc.timeline, eventItems);
  provideRoomPins(pins);
  $effect(() => {
    void revision;
    void pins.refresh(menuProps.roomId);
  });
  provideRoomScopes(new RoomScopes(core));
  provideBookmarks(new Bookmarks(core.rpc.account));
</script>

<TooltipProvider>
  <RoomPinMenu {...menuProps} bind:open />
  <span data-testid="pins-unread">{pins.unread}</span>
  {#if mediaViewerState.eventId}
    <MediaViewer />
  {/if}
</TooltipProvider>
