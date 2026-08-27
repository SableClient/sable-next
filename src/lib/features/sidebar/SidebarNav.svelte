<script lang="ts">
  import { i18n } from '#lib/i18n.js';
  import type { RoomSummary } from '#src/generated/RoomSummary';
  import { onMount } from 'svelte';
  import { useCoreClient } from '#lib/core/context.js';
  import { useRoomList } from '#lib/rooms/room-list.svelte.js';
  import { addUnread, spaceUnreadCounts, type UnreadCount } from '#lib/rooms/spaces.js';
  import {
    applyDrop,
    folderName,
    mergeSpaces,
    removeFromFolder,
    renameFolder,
    ungroupFolder,
    type DropInstruction,
    type LayoutRef,
    type SidebarFolder,
  } from '#lib/spaces/sidebar-layout.js';
  import { readReceiptIsPrivate } from '#lib/settings/preferences.svelte.js';
  import { useSpaceSidebar } from '#lib/spaces/sidebar-layout.svelte.js';
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
  const spaceSidebar = useSpaceSidebar();
  let renamingFolder = $state<SidebarFolder | null>(null);
  let dragging = $state(false);
  let drag: { pointerId: number; startX: number; startWidth: number } | undefined;
  let collapsed = $derived(roomNavWidth < COLLAPSED_ROOM_NAV_WIDTH);
  let spaces = $derived.by(() => {
    const joinedSpaces = roomList.rooms.filter(isActiveSpace);
    const childSpaceIds = joinedSpaces.flatMap((space) =>
      space.space_children.map((child) => child.room_id)
    );

    return joinedSpaces.filter((space) => !childSpaceIds.includes(space.room_id));
  });
  let claimed = $derived(claimedRoomIds(roomList.rooms));
  let spaceUnread = $derived(spaceUnreadCounts(spaces, roomList.rooms, roomList.mutedRoomIds));
  let entries = $derived(
    mergeSpaces(
      spaceSidebar.items,
      spaces.map((space) => space.room_id)
    )
  );
  let homeRooms = $derived(
    roomList.rooms.filter(
      (room) =>
        room.state === 'joined' &&
        !room.is_space &&
        !room.is_direct &&
        !roomList.mutedRoomIds.has(room.room_id)
    )
  );
  let homeUnread = $derived(unreadCounts(homeRooms));
  let unspacedUnread = $derived(
    unreadCounts(homeRooms.filter((room) => !claimed.has(room.room_id)))
  );
  let allDirectRooms = $derived(
    roomList.rooms.filter(
      (room) =>
        room.state === 'joined' && room.is_direct && !roomList.mutedRoomIds.has(room.room_id)
    )
  );
  let directRooms = $derived(
    allDirectRooms
      .filter((room) => room.highlight > 0 || room.unread > 0)
      .toSorted(
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
    return rooms.reduce(
      (total, room) => addUnread(total, { unread: room.unread, highlight: room.highlight }),
      { unread: 0, highlight: 0 }
    );
  }

  function markSectionRead(section: 'home' | 'direct'): void {
    markRoomsRead(
      section === 'home' ? homeRooms : allDirectRooms,
      core.commands,
      readReceiptIsPrivate()
    );
  }

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

  function handleResizeStart(event: PointerEvent) {
    if (event.button !== 0) return;

    const handle = event.currentTarget;
    if (!(handle instanceof HTMLElement)) return;

    drag = { pointerId: event.pointerId, startX: event.clientX, startWidth: roomNavWidth };
    dragging = true;
    handle.setPointerCapture(event.pointerId);
  }

  function handleResizeMove(event: PointerEvent) {
    if (!drag || event.pointerId !== drag.pointerId) return;

    roomNavWidth = clampRoomNavWidth(drag.startWidth + event.clientX - drag.startX);
  }

  function finishResize(event: PointerEvent) {
    if (!drag || event.pointerId !== drag.pointerId) return;

    drag = undefined;
    dragging = false;
    persistRoomNavWidth();
  }

  function handleResizeKeydown(event: KeyboardEvent) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;

    event.preventDefault();
    roomNavWidth = clampRoomNavWidth(
      roomNavWidth + (event.key === 'ArrowLeft' ? -ROOM_NAV_WIDTH_STEP : ROOM_NAV_WIDTH_STEP)
    );
    persistRoomNavWidth();
  }

  function persistRoomNavWidth() {
    localStorage.setItem(ROOM_NAV_STORAGE_KEY, String(roomNavWidth));
  }

  function folderLabel(folder: SidebarFolder): string {
    return (
      folderName(
        folder,
        (roomId) => roomList.rooms.find((room) => room.room_id === roomId)?.name ?? null
      ) ?? ''
    );
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
  };
</script>

<aside class="sidebar">
  {#if mobile}
    <nav class="mobile-navigation" aria-label={$i18n.t('nav.primary')}>
      <div class="navigation-main">
        <NavigationRail
          {spaces}
          {spaceUnread}
          {homeUnread}
          {unspacedUnread}
          {directRooms}
          {directUnread}
          mobile
          {onNavigate}
          {...railProps}
        />
        <RoomNav {onNavigate} />
      </div>
      <UserQuickTools mobile {onNavigate} />
    </nav>
  {:else}
    <nav class="desktop-navigation" aria-label={$i18n.t('nav.primary')}>
      <div class="desktop-navigation-main">
        <NavigationRail
          {spaces}
          {spaceUnread}
          {homeUnread}
          {unspacedUnread}
          {directRooms}
          {directUnread}
          {...railProps}
        />
        <RoomNav width={roomNavWidth} {collapsed} />
        <button
          type="button"
          class="resize-handle"
          class:dragging
          role="slider"
          aria-orientation="horizontal"
          aria-valuemin={MIN_ROOM_NAV_WIDTH}
          aria-valuemax={MAX_ROOM_NAV_WIDTH}
          aria-valuenow={roomNavWidth}
          aria-label={$i18n.t('nav.resizeRooms')}
          onpointerdown={handleResizeStart}
          onpointermove={handleResizeMove}
          onpointerup={finishResize}
          onpointercancel={finishResize}
          onkeydown={handleResizeKeydown}
        ></button>
      </div>
      {#if collapsed}
        <UserQuickTools compact />
      {:else}
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
      position: fixed;
      top: 0;
      width: calc(var(--navigation-rail-width) + var(--room-nav-width));
      z-index: 1;
    }

    .desktop-navigation {
      display: flex;
    }

    .resize-handle {
      appearance: none;
      background: transparent;
      border: 0;
      cursor: col-resize;
      height: 100%;
      padding: 0;
      position: absolute;
      right: -0.25rem;
      top: 0;
      touch-action: none;
      user-select: none;
      width: 0.5rem;
    }

    .resize-handle:hover,
    .resize-handle.dragging,
    .resize-handle:focus-visible {
      background: var(--sable-primary-main);
    }

    .resize-handle:focus-visible {
      outline: var(--focus-ring-width) solid var(--sable-focus-ring);
      outline-offset: -3px;
    }
  }
</style>
