<script lang="ts">
  import type { Snippet } from 'svelte';
  import IconContext from 'phosphor-svelte/lib/IconContext';

  import type { CoreClient } from '#lib/core/client.svelte.js';
  import { provideCoreClient } from '#lib/core/context.js';
  import { provideRecentReactions, RecentReactions } from '#lib/emoji/recents.svelte.ts';
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
  import { mockImageBytes } from './mock-media';
  import { mockRpc as generatedRpc, type RpcOverrides } from './mock-rpc';

  let { children, rpc = {} }: { children: Snippet; rpc?: RpcOverrides } = $props();

  const getRemoteMedia = async (url: string) => {
    const res = await fetch(url);
    const blob = await res.blob();
    const bytes = await blob.bytes();
    return bytes;
  };

  const REMOTE_MEDIA: [(source: string) => boolean, string][] = [
    [(s) => s.includes('wav') && s.includes('metadata'), 'outgoing_call_metadata.webm'],
    [(s) => s.includes('wav'), 'outgoing_call.webm'],
    [(s) => s.includes('flac'), 'find%20it.flac'],
    [(s) => s.includes('mp4'), 'Big_Buck_Bunny_4K.webm'],
    [(s) => s.includes('json'), 'example.json'],
  ];

  // A sized request is a thumbnail, which is always an image.
  const mockFetchMedia = async (source: string, width: number, height: number) => {
    const remote = width > 0 && height > 0 ? undefined : REMOTE_MEDIA.find(([is]) => is(source));
    return remote
      ? getRemoteMedia(`https://copse.f0rest.net/junk/${remote[1]}`)
      : mockImageBytes(source, width, height);
  };

  const noop = () => {};
  const mockRpc = { rpc: generatedRpc(untrack(() => rpc)) };
  const mockCore = {
    ...mockRpc,
    onProfileChanged: () => noop,
    subscribeEvents: () => noop,
    cachedUserProfile: noop,
    media: {
      fetchMedia: mockFetchMedia,
    },
  } as unknown as CoreClient;

  provideCoreClient(mockCore);

  provideRecentReactions(new RecentReactions(mockCore));
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
