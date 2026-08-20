<script lang="ts">
  import { i18n } from '#lib/i18n.js';
  import type { RoomSummary } from '#src/generated/RoomSummary';
  import { onMount } from 'svelte';
  import { useRoomList } from '#lib/rooms/room-list.svelte.js';
  import { unreadSpaceIds } from '#lib/rooms/spaces.js';
  import NavigationRail from './NavigationRail.svelte';
  import RoomNav from './RoomNav.svelte';
  import UserQuickTools from './UserQuickTools.svelte';

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
  const roomList = useRoomList();
  let dragging = $state(false);
  let drag: { pointerId: number; startX: number; startWidth: number } | undefined;
  let collapsed = $derived(roomNavWidth < COLLAPSED_ROOM_NAV_WIDTH);
  let spaces = $derived.by(() => {
    const joinedSpaces = roomList.rooms.filter((room) => room.is_space && room.state === 'joined');
    const childSpaceIds = joinedSpaces.flatMap((space) =>
      space.space_children.map((child) => child.room_id)
    );

    return joinedSpaces.filter((space) => !childSpaceIds.includes(space.room_id));
  });
  let claimedRoomIds = $derived(
    new Set(
      roomList.rooms
        .filter((room) => room.is_space && room.state === 'joined')
        .flatMap((space) => space.space_children.map((child) => child.room_id))
    )
  );
  let unreadSpaces = $derived(unreadSpaceIds(spaces, roomList.rooms, roomList.mutedRoomIds));
  let homeCounts = $derived(
    unreadCounts(
      roomList.rooms.filter(
        (room) =>
          room.state === 'joined' &&
          !room.is_space &&
          !room.is_direct &&
          !claimedRoomIds.has(room.room_id) &&
          !roomList.mutedRoomIds.has(room.room_id)
      )
    )
  );
  let homeUnread = $derived(homeCounts.highlight || homeCounts.unread);
  let homeHighlight = $derived(homeCounts.highlight > 0);
  let directCounts = $derived(
    unreadCounts(
      roomList.rooms.filter(
        (room) =>
          room.state === 'joined' && room.is_direct && !roomList.mutedRoomIds.has(room.room_id)
      )
    )
  );
  let directUnread = $derived(directCounts.highlight || directCounts.unread);

  function unreadCounts(rooms: readonly RoomSummary[]) {
    return rooms.reduce(
      (total, room) => ({
        unread: total.unread + room.unread,
        highlight: total.highlight + room.highlight,
      }),
      { unread: 0, highlight: 0 }
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
</script>

<aside class="sidebar">
  {#if mobile}
    <nav class="mobile-navigation" aria-label={$i18n.t('nav.primary')}>
      <div class="navigation-main">
        <NavigationRail
          {spaces}
          unreadSpaceIds={unreadSpaces}
          {homeUnread}
          {homeHighlight}
          {directUnread}
          mobile
          {onNavigate}
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
          unreadSpaceIds={unreadSpaces}
          {homeUnread}
          {homeHighlight}
          {directUnread}
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
