<script lang="ts">
  import type { Snippet } from 'svelte';

  import type { CoreClient } from '#lib/core/client.svelte.js';
  import { provideCoreClient } from '#lib/core/context.js';
  import { createRpc } from '#src/generated/protocol';
  import { provideRoomCosmetics, RoomCosmetics } from '#lib/rooms/room-cosmetics.svelte.ts';
  import { provideSenderRoles } from '#lib/features/room/members/sender-roles.ts';
  import {
    PinnedEvents,
    providePinnedEvents,
    type PinnedEventCommands,
  } from '#lib/features/room/timeline/pinned-events.svelte.ts';
  import {
    Bookmarks,
    provideBookmarks,
    type BookmarkCommands,
  } from '#lib/rooms/bookmarks.svelte.ts';
  import {
    MessageDialogs,
    provideMessageDialogs,
  } from '#lib/features/room/messages/message-dialogs.svelte.ts';
  import {
    OpenMessageMenu,
    provideMessageMenu,
  } from '#lib/features/room/messages/message-menu-open.svelte.ts';
  import { PersonaStore, providePersonaStore } from '#lib/personas/personas.svelte.ts';
  import { provideRoomList, RoomList } from '#lib/rooms/room-list.svelte.ts';

  let { children }: { children: Snippet } = $props();

  const noop = () => {};
  const mockRpc = { rpc: createRpc(() => new Promise(() => {})) };
  const mockCore = {
    ...mockRpc,
    onProfileChanged: () => noop,
    subscribeEvents: noop,
    cachedUserProfile: noop,
    media: { fetchMedia: () => new Promise(() => {}) },
  } as unknown as CoreClient;

  provideCoreClient(mockCore);

  provideRoomCosmetics({ ...mockRpc, for: noop } as unknown as RoomCosmetics);
  provideSenderRoles(() => null);
  providePinnedEvents(new PinnedEvents(mockRpc as unknown as PinnedEventCommands));
  provideBookmarks(new Bookmarks(mockRpc as unknown as BookmarkCommands));
  provideMessageDialogs(new MessageDialogs());
  provideMessageMenu(new OpenMessageMenu());
  providePersonaStore(new PersonaStore(mockCore));
  provideRoomList(new RoomList(mockCore));
</script>

{@render children()}
