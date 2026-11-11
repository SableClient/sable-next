<script lang="ts">
  import { i18n } from '#lib/i18n.js';
  import { readText, writeText } from '#lib/platform/local-json.js';
  import type { RoomListItemView } from '#src/generated/protocol';
  import { onMount } from 'svelte';
  import { afterNavigate, goto } from '$app/navigation';
  import { page } from '$app/state';
  import { useCoreClient } from '#lib/core/context.js';
  import ActiveCallBar from '#lib/features/call/ActiveCallBar.svelte';
  import { useCallSession } from '#lib/features/call/call-session.svelte.js';
  import { roomSectionPath } from '#lib/rooms/permalink.js';
  import { findRoomByPathId, useRoomList } from '#lib/rooms/room-list.svelte.js';
  import { addUnread, spacesContaining, spacesContainingRoom } from '#lib/rooms/spaces.js';
  import { hasUnread, NO_UNREAD } from '#lib/rooms/unread.js';
  import {
    applyDrop,
    folderName,
    layoutSpaceIds,
    mergeSpaces,
    orderedKnownSpaceIds,
    rememberSpaceIds,
    removeFromFolder,
    renameFolder,
    setFolderIcon,
    ungroupFolder,
    withoutSpace,
    type DropInstruction,
    type LayoutRef,
    type SidebarFolder,
  } from '#lib/spaces/sidebar-layout.js';
  import { useSpaceSidebar } from '#lib/spaces/sidebar-layout.svelte.js';
  import ResizeHandle from '#lib/ui/primitives/ResizeHandle.svelte';
  import FolderRenameDialog from './FolderRenameDialog.svelte';
  import SidebarIconDialog, { type IconTarget } from './SidebarIconDialog.svelte';
  import NavigationRail from './NavigationRail.svelte';
  import RoomNav from './RoomNav.svelte';
  import UserQuickTools from './UserQuickTools.svelte';
  import { isActiveSpace, markRoomsRead } from './nav-rooms.js';
  import CoreHealthBanner from '#lib/ui/CoreHealthBanner.svelte';

  interface Props {
    mobile?: boolean;
    onNavigate?: (href: string) => void;
    roomNavWidth?: number;
  }

  const MIN_ROOM_NAV_WIDTH = 50;
  const COLLAPSED_ROOM_NAV_WIDTH = 230;
  const MAX_ROOM_NAV_WIDTH = 500;
  const ROOM_NAV_WIDTH_STEP = 80;
  const ROOM_NAV_STORAGE_KEY = 'sable-room-navigation-width';

  let { mobile = false, onNavigate, roomNavWidth = $bindable(288) }: Props = $props();
  const core = useCoreClient();
  const roomList = useRoomList();
  const call = useCallSession();
  let pathname = $state(page.url.pathname === '/create-room' ? '/rooms' : page.url.pathname);
  let spaceId = $state(page.params.spaceId);
  let roomId = $state(page.params.roomId);

  afterNavigate(() => {
    roomId = page.params.roomId;
    if (
      page.url.pathname === '/inbox' ||
      page.url.pathname === '/search' ||
      page.url.pathname === '/create-room'
    )
      return;
    pathname = page.url.pathname;
    spaceId = page.params.spaceId;
  });

  const spaceSidebar = useSpaceSidebar();
  let renamingFolder = $state<SidebarFolder | null>(null);
  let iconTarget = $state.raw<IconTarget | null>(null);
  let knownSpaceIds = $state.raw<string[]>([]);
  let collapsed = $derived(roomNavWidth < COLLAPSED_ROOM_NAV_WIDTH);
  let joinedSpaces = $derived(roomList.rooms.filter(isActiveSpace));
  let orphanSpaces = $derived.by(() => {
    const childSpaceIds = new Set(
      joinedSpaces.flatMap((space) => space.space_children.map((child) => child.room_id))
    );

    return joinedSpaces.filter((space) => !childSpaceIds.has(space.room_id));
  });
  let pinnedSpaceIds = $derived.by(() => {
    const stored = new Set(layoutSpaceIds(spaceSidebar.items));
    const orphans = new Set(orphanSpaces.map((space) => space.room_id));

    return new Set(
      joinedSpaces
        .filter((space) => stored.has(space.room_id) && !orphans.has(space.room_id))
        .map((space) => space.room_id)
    );
  });
  let spaces = $derived([
    ...orphanSpaces,
    ...joinedSpaces.filter((space) => pinnedSpaceIds.has(space.room_id)),
  ]);
  let orderedSpaceIds = $derived(
    orderedKnownSpaceIds(
      knownSpaceIds,
      spaces.map((space) => space.room_id)
    )
  );
  let callRoom = $derived(roomList.byId(call.roomId));
  let spaceUnread = $derived(
    new Map(
      spaces.flatMap((space) => {
        const unread = roomList.section(space.room_id)?.unread;
        return unread && hasUnread(unread) ? [[space.room_id, unread] as const] : [];
      })
    )
  );
  let callSpaces = $derived(
    call.active ? spacesContainingRoom(spaces, roomList.rooms, call.roomId) : new Set<string>()
  );
  let voiceSpaces = $derived(
    spacesContaining(
      spaces,
      roomList.rooms,
      (room) => room.state === 'joined' && room.call_participants.length > 0
    )
  );
  let entries = $derived(mergeSpaces(spaceSidebar.items, orderedSpaceIds));
  let homeUnread = $derived(roomList.section('home')?.unread ?? NO_UNREAD);
  let unspacedUnread = $derived(roomList.section('unspaced')?.unread ?? NO_UNREAD);
  let openRoomId = $derived(findRoomByPathId(roomList.rooms, roomId)?.room_id);
  let unreadDirectRooms = $derived(
    (roomList.section('direct')?.unread_rooms ?? []).flatMap((id) =>
      id === openRoomId ? [] : (roomList.byId(id) ?? [])
    )
  );
  let directRooms = $derived(unreadDirectRooms.slice(0, 3));
  let directUnread = $derived(
    unreadDirectRooms
      .slice(3)
      .reduce((total, room) => addUnread(total, roomList.badgeUnreadFor(room)), NO_UNREAD)
  );

  function sectionRooms(roomIds: readonly string[]): RoomListItemView[] {
    return roomIds.flatMap((id) => roomList.byId(id) ?? []);
  }

  function markSectionRead(key: 'home' | 'unspaced' | 'direct'): void {
    const section = roomList.section(key);
    if (!section) return;
    markRoomsRead(sectionRooms([...section.favourites, ...section.rooms]), core.rpc.timeline);
  }

  function markFolderRead(folder: SidebarFolder): void {
    markRoomsRead(
      sectionRooms(
        folder.content.flatMap((spaceId) => roomList.section(spaceId)?.descendants ?? [])
      ),
      core.rpc.timeline
    );
  }

  $effect.pre(() => {
    const next = rememberSpaceIds(
      knownSpaceIds,
      spaces.map((space) => space.room_id)
    );
    if (next.length !== knownSpaceIds.length) knownSpaceIds = next;
  });

  onMount(() => {
    const storedWidth = Number.parseInt(readText(ROOM_NAV_STORAGE_KEY) ?? '', 10);
    if (Number.isFinite(storedWidth)) roomNavWidth = clampRoomNavWidth(storedWidth);
  });

  function clampRoomNavWidth(width: number) {
    const clamped = Math.max(MIN_ROOM_NAV_WIDTH, Math.min(MAX_ROOM_NAV_WIDTH, width));

    if (clamped > MIN_ROOM_NAV_WIDTH && clamped < COLLAPSED_ROOM_NAV_WIDTH) {
      return clamped - MIN_ROOM_NAV_WIDTH < COLLAPSED_ROOM_NAV_WIDTH - clamped
        ? MIN_ROOM_NAV_WIDTH
        : COLLAPSED_ROOM_NAV_WIDTH;
    }

    return clamped;
  }

  function persistRoomNavWidth() {
    writeText(ROOM_NAV_STORAGE_KEY, String(roomNavWidth));
  }

  function folderLabel(folder: SidebarFolder): string {
    return folderName(folder, (roomId) => roomList.byId(roomId)?.name ?? null) ?? '';
  }

  const railProps = {
    get layout() {
      return entries;
    },
    get openFolders() {
      return spaceSidebar.openFolders;
    },
    onToggleFolder: (folderId: string) => {
      spaceSidebar.toggleFolder(folderId);
    },
    onCollapseFolders: () => {
      spaceSidebar.collapseAllFolders();
    },
    onRenameFolder: (folder: SidebarFolder) => {
      renamingFolder = folder;
    },
    onChangeFolderIcon: (folder: SidebarFolder) => {
      iconTarget = {
        id: folder.id,
        name: folderLabel(folder),
        icon: folder.icon,
        fallback: null,
        description: i18n.t('nav.folderIconDescription'),
        save: (icon) => {
          spaceSidebar.write(setFolderIcon(entries, folder.id, icon));
        },
      };
    },
    onChangeSpaceIcon: (roomId: string) => {
      const space = roomList.byId(roomId);
      if (space === undefined) return;
      iconTarget = {
        id: roomId,
        name: space.display_name,
        icon: space.display_avatar_url === space.avatar_url ? null : space.display_avatar_url,
        fallback: space.avatar_url,
        description: i18n.t('nav.spaceIconDescription'),
        save: async (icon) => {
          await core.rpc.spaces.setAvatarOverride({ room_id: roomId, url: icon });
        },
      };
    },
    onUngroupFolder: (folderId: string) => {
      spaceSidebar.write(ungroupFolder(entries, folderId));
    },
    onRemoveFromFolder: (roomId: string, folderId: string) => {
      spaceSidebar.write(removeFromFolder(entries, roomId, folderId));
    },
    onReorder: (source: LayoutRef, target: LayoutRef, instruction: DropInstruction) => {
      spaceSidebar.write(applyDrop(entries, source, target, instruction));
    },
    onMarkSectionRead: markSectionRead,
    onMarkFolderRead: markFolderRead,
    get pinnedSpaceIds() {
      return pinnedSpaceIds;
    },
    onUnpin: (roomId: string) => {
      spaceSidebar.write(withoutSpace(entries, roomId));
    },
  };
</script>

{#snippet callBar()}
  {#if call.active}
    <ActiveCallBar
      session={call}
      roomName={callRoom?.name ?? i18n.t('call.title')}
      collapsed={!mobile && collapsed}
      onReturn={() => {
        if (call.roomId === null) return;
        // eslint-disable-next-line svelte/no-navigation-without-resolve -- roomSectionPath() resolves the route itself
        void goto(roomSectionPath(roomList.rooms, call.roomId));
      }}
    />
  {/if}
{/snippet}

<aside class="sidebar">
  {#if mobile}
    <nav class="mobile-navigation" aria-label={i18n.t('nav.primary')}>
      <CoreHealthBanner />
      <div class="navigation-main">
        <NavigationRail
          {pathname}
          {spaces}
          {spaceUnread}
          {callSpaces}
          {voiceSpaces}
          {homeUnread}
          {unspacedUnread}
          {directRooms}
          {directUnread}
          unreadFor={roomList.badgeUnreadFor}
          mobile
          {onNavigate}
          {...railProps}
        />
        <RoomNav
          {pathname}
          {spaceId}
          {roomId}
          {onNavigate}
          callRoomId={call.active ? call.roomId : null}
          callVoiceStates={call.voiceStates}
        />
      </div>
      {@render callBar()}
      <UserQuickTools mobile {onNavigate} />
    </nav>
  {:else}
    <nav class="desktop-navigation" aria-label={i18n.t('nav.primary')}>
      <div class="desktop-navigation-main">
        <NavigationRail
          {pathname}
          {spaces}
          {spaceUnread}
          {callSpaces}
          {voiceSpaces}
          {homeUnread}
          {unspacedUnread}
          {directRooms}
          {directUnread}
          unreadFor={roomList.badgeUnreadFor}
          compact={collapsed}
          {...railProps}
        />
        <RoomNav
          {pathname}
          {spaceId}
          {roomId}
          width={roomNavWidth}
          {collapsed}
          callRoomId={call.active ? call.roomId : null}
          callVoiceStates={call.voiceStates}
        />
        <ResizeHandle
          value={roomNavWidth}
          min={MIN_ROOM_NAV_WIDTH}
          max={MAX_ROOM_NAV_WIDTH}
          label={i18n.t('nav.resizeRooms')}
          grow="right"
          step={ROOM_NAV_WIDTH_STEP}
          onResize={(next) => (roomNavWidth = clampRoomNavWidth(next))}
          onCommit={persistRoomNavWidth}
        />
      </div>
      {@render callBar()}
      {#if !collapsed}
        <UserQuickTools />
      {/if}
    </nav>
  {/if}
  <FolderRenameDialog
    folder={renamingFolder}
    shownName={renamingFolder === null ? '' : folderLabel(renamingFolder)}
    onOpenChange={(open: boolean) => {
      if (!open) renamingFolder = null;
    }}
    onRename={(folderId: string, name: string) => {
      spaceSidebar.write(renameFolder(entries, folderId, name));
    }}
  />
  <SidebarIconDialog
    target={iconTarget}
    onOpenChange={(open: boolean) => {
      if (!open) iconTarget = null;
    }}
  />
</aside>

<style>
  .desktop-navigation {
    display: none;
    flex-direction: column;
  }

  .desktop-navigation-main {
    display: flex;
    flex: 1;
    min-height: 0;
  }

  .mobile-navigation,
  .desktop-navigation {
    height: 100%;
    min-height: 0;
  }

  .mobile-navigation {
    display: flex;
    flex-direction: column;
    width: 100%;
  }

  .navigation-main {
    display: flex;
    flex: 1;
    min-height: 0;
  }

  .sidebar {
    height: 100%;
    width: 100%;
  }

  @media (--app-layout) {
    .sidebar {
      height: 100dvh;
      left: 0;
      padding-left: var(--safe-left);
      padding-top: var(--safe-top);
      position: fixed;
      top: 0;
      width: calc(var(--navigation-rail-width) + var(--room-nav-width) + var(--safe-left));
      z-index: 2;
    }

    .desktop-navigation {
      display: flex;
    }

    .desktop-navigation-main :global(.resize-handle) {
      right: -0.25rem;
    }
  }
</style>
