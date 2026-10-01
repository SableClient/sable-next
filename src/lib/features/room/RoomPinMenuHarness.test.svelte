<script lang="ts">
  import type { ComponentProps } from 'svelte';

  import { useCoreClient } from '#lib/core/context.js';
  import { Bookmarks, provideBookmarks } from '#lib/rooms/bookmarks.svelte.js';
  import TooltipProvider from '#lib/ui/primitives/TooltipProvider.svelte';

  import { EventItems, provideEventItems } from './messages/event-items.svelte.js';
  import { RoomScopes, provideRoomScopes } from './messages/message-scope.svelte.js';
  import MediaViewer, { type MediaItem } from './media/MediaViewer.svelte';
  import RoomPinMenu from './RoomPinMenu.svelte';

  let { menu }: { menu: ComponentProps<typeof RoomPinMenu> } = $props();
  const core = useCoreClient();
  provideEventItems(new EventItems(core.commands, () => core.session?.account_id ?? null));
  provideRoomScopes(new RoomScopes(core));
  provideBookmarks(new Bookmarks(core.commands));
  let items = $state.raw<MediaItem[]>([]);
  let selectedEventId = $state<string | null>(null);
</script>

<TooltipProvider>
  <RoomPinMenu
    {...menu}
    onOpenMedia={(next, eventId) => {
      items = next;
      selectedEventId = eventId;
      menu.onOpenMedia(next, eventId);
    }}
  />
  {#if selectedEventId}
    <MediaViewer {items} {selectedEventId} onClose={() => (selectedEventId = null)} />
  {/if}
</TooltipProvider>
