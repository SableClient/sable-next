<script lang="ts">
  import { i18n } from '#lib/i18n.js';
  import type { RoomSummary } from '#src/generated/protocol';
  import { onMount } from 'svelte';
  import { goto } from '$app/navigation';
  import { useCoreClient } from '#lib/core/context.js';
  import ActiveCallBar from '#lib/features/call/ActiveCallBar.svelte';
  import { useCallSession } from '#lib/features/call/call-session.svelte.js';
  import { roomSectionPath } from '#lib/rooms/permalink.js';
  import { useRoomList } from '#lib/rooms/room-list.svelte.js';
  import {
    addUnread,
    spacesContainingRoom,
    spaceUnreadCounts,
    type UnreadCount,
  } from '#lib/rooms/spaces.js';
  import { hasUnread } from '#lib/rooms/unread.js';
  import {
    applyDrop,
    folderName,
    layoutSpaceIds,
    mergeSpaces,
    orderedKnownSpaceIds,
    rememberSpaceIds,
    removeFromFolder,
    renameFolder,
    ungroupFolder,
    withoutSpace,
    type DropInstruction,
    type LayoutRef,
    type SidebarFolder,
  } from '#lib/spaces/sidebar-layout.js';
  import { readReceiptIsPrivate } from '#lib/settings/preferences.svelte.js';
  import { useSpaceSidebar } from '#lib/spaces/sidebar-layout.svelte.js';
  import ResizeHandle from '#lib/ui/primitives/ResizeHandle.svelte';
  import FolderRenameDialog from './FolderRenameDialog.svelte';
  import NavigationRail from './NavigationRail.svelte';
  import RoomNav from './RoomNav.svelte';
  import UserQuickTools from './UserQuickTools.svelte';
  import { claimedRoomIds, isActiveSpace, markRoomsRead } from './nav-rooms.js';

  interface Props {
    mobile?: boolean;
    onNavigate?: (href: string) => void;
    roomNavWidth?: number;
  }

  const MIN_ROOM_NAV_WIDTH = 50;
  const COLLAPSED_ROOM_NAV_WIDTH = 190;
  const MAX_ROOM_NAV_WIDTH = 500;
  const ROOM_NAV_WIDTH_STEP = 80;
  const ROOM_NAV_STORAGE_KEY = 'sable-room-navigation-width';

  let { mobile = false, onNavigate, roomNavWidth = $bindable(224) }: Props = $props();
  const core = useCoreClient();
  const roomList = useRoomList();
  const call = useCallSession();

  function setCallVolume(userId: string, volume: number): void {
    for (const member of call.members) {
      if (member.user_id === userId) void call.setParticipantVolume(member.identity, volume);
    }
  }
  const spaceSidebar = useSpaceSidebar();
  let renamingFolder = $state<SidebarFolder | null>(null);
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
  let claimed = $derived(claimedRoomIds(roomList.rooms));
  let orderedSpaceIds = $derived(
    orderedKnownSpaceIds(
      knownSpaceIds,
      spaces.map((space) => space.room_id)
    )
  );
  let callRoom = $derived(roomList.byId(call.roomId));
  let spaceUnread = $derived(
    spaceUnreadCounts(spaces, roomList.rooms, roomList.notificationModeOf)
  );
  let callSpaces = $derived(
    call.active ? spacesContainingRoom(spaces, roomList.rooms, call.roomId) : new Set<string>()
  );
  let entries = $derived(mergeSpaces(spaceSidebar.items, orderedSpaceIds));
  let joinedRooms = $derived(
    roomList.rooms.filter((room) => room.state === 'joined' && !room.is_space)
  );
  let unspacedRooms = $derived(
    joinedRooms.filter((room) => !room.is_direct && !claimed.has(room.room_id))
  );
  let unspacedUnread = $derived(unreadCounts(unspacedRooms));
  let allDirectRooms = $derived(
    roomList.rooms.filter((room) => room.state === 'joined' && room.is_direct)
  );
  let directRooms = $derived(
    allDirectRooms
      .filter((room) => hasUnread(roomList.unreadFor(room)))
      .sort(
        (left, right) => (right.latest_event?.timestamp ?? 0) - (left.latest_event?.timestamp ?? 0)
      )
      .slice(0, 3)
  );
  let directUnread = $derived(
    unreadCounts(
      allDirectRooms.filter(
        (room) => !directRooms.some((directRoom) => directRoom.room_id === room.room_id)
      )
    )
  );

  function unreadCounts(rooms: readonly RoomSummary[]): UnreadCount {
    return rooms.reduce((total, room) => addUnread(total, roomList.unreadFor(room)), {
      unread: 0,
      highlight: 0,
    });
  }

  function markSectionRead(section: 'unspaced' | 'direct'): void {
    const rooms = { unspaced: unspacedRooms, direct: allDirectRooms }[section];
    markRoomsRead(rooms, core.commands, readReceiptIsPrivate());
  }

  $effect.pre(() => {
    const next = rememberSpaceIds(
      knownSpaceIds,
      spaces.map((space) => space.room_id)
    );
    if (next.length !== knownSpaceIds.length) knownSpaceIds = next;
  });

  onMount(() => {
    const storedWidth = Number.parseInt(localStorage.getItem(ROOM_NAV_STORAGE_KEY) ?? '', 10);
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
    localStorage.setItem(ROOM_NAV_STORAGE_KEY, String(roomNavWidth));
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
    onRenameFolder: (folder: SidebarFolder) => {
      renamingFolder = folder;
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
      roomName={callRoom?.name ?? $i18n.t('call.title')}
      collapsed={!mobile && collapsed}
      onReturn={() => {
        if (call.roomId === null) return;
        void goto(roomSectionPath(roomList.rooms, call.roomId));
      }}
    />
  {/if}
{/snippet}

<aside class="sidebar">
  {#if mobile}
    <nav class="mobile-navigation" aria-label={$i18n.t('nav.primary')}>
      <div class="navigation-main">
        <NavigationRail
          {spaces}
          {spaceUnread}
          {callSpaces}
          {unspacedUnread}
          {directRooms}
          {directUnread}
          unreadFor={roomList.unreadFor}
          mobile
          {onNavigate}
          {...railProps}
        />
        <RoomNav
          {onNavigate}
          callRoomId={call.active ? call.roomId : null}
          callVoiceStates={call.voiceStates}
          onCallVolume={setCallVolume}
        />
      </div>
      {@render callBar()}
      <UserQuickTools mobile {onNavigate} />
    </nav>
  {:else}
    <nav class="desktop-navigation" aria-label={$i18n.t('nav.primary')}>
      <div class="desktop-navigation-main">
        <NavigationRail
          {spaces}
          {spaceUnread}
          {callSpaces}
          {unspacedUnread}
          {directRooms}
          {directUnread}
          unreadFor={roomList.unreadFor}
          compact={collapsed}
          {...railProps}
        />
        <RoomNav
          width={roomNavWidth}
          {collapsed}
          callRoomId={call.active ? call.roomId : null}
          callVoiceStates={call.voiceStates}
          onCallVolume={setCallVolume}
        />
        <ResizeHandle
          value={roomNavWidth}
          min={MIN_ROOM_NAV_WIDTH}
          max={MAX_ROOM_NAV_WIDTH}
          label={$i18n.t('nav.resizeRooms')}
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

  @media (width >= 48rem) {
    .sidebar {
      height: 100dvh;
      left: 0;
      padding-top: var(--titlebar-height);
      position: fixed;
      top: 0;
      width: calc(var(--navigation-rail-width) + var(--room-nav-width));
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
