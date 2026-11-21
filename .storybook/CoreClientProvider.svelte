<script lang="ts">
  import type { Snippet } from 'svelte';
  import IconContext from 'phosphor-svelte/lib/IconContext';

  import type { CoreClient } from '#lib/core/client.svelte.js';
  import { provideCoreClient } from '#lib/core/context.js';
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
  import { provideSpaceSidebar, SpaceSidebar } from '#lib/spaces/sidebar-layout.svelte.ts';

  import { untrack } from 'svelte';
  import { mockRpc as generatedRpc, type RpcOverrides } from './mock-rpc';

  let { children, rpc = {} }: { children: Snippet; rpc?: RpcOverrides } = $props();

  const getRemoteMedia = async (url: string) => {
    const res = await fetch(url);
    const blob = await res.blob();
    const bytes = await blob.bytes();
    return bytes;
  };

  const mockFetchMedia = async (source: string, width: number, height: number) => {
    if (source.includes('placehold.co')) {
      return getRemoteMedia(source);
    }
    if (!!width && width > 0 && !!height && height > 0) {
      return getRemoteMedia(`https://placehold.co/${width}x${height}.png`);
    }
    if (source.includes('wav') && source.includes('metadata')) {
      return getRemoteMedia('https://copse.f0rest.net/junk/outgoing_call_metadata.webm');
    }
    if (source.includes('wav')) {
      return getRemoteMedia('https://copse.f0rest.net/junk/outgoing_call.webm');
    }
    if (source.includes('flac')) {
      return getRemoteMedia('https://copse.f0rest.net/junk/find%20it.flac');
    }
    if (source.includes('mp4')) {
      return getRemoteMedia('https://copse.f0rest.net/junk/Big_Buck_Bunny_4K.webm');
    }
    if (source.includes('json')) {
      return getRemoteMedia('https://copse.f0rest.net/junk/example.json');
    }

    return getRemoteMedia(`https://placehold.co/1600x900.png`);
  };

  const noop = () => {};
  const mockRpc = { rpc: generatedRpc(untrack(() => rpc)) };
  const mockCore = {
    ...mockRpc,
    onProfileChanged: () => noop,
    subscribeEvents: noop,
    cachedUserProfile: noop,
    media: {
      fetchMedia: mockFetchMedia,
    },
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
  provideSpaceSidebar(new SpaceSidebar());
</script>

<!-- The root layout does the same for the app. -->
<IconContext values={{ 'aria-hidden': true }}>
  {@render children()}
</IconContext>
