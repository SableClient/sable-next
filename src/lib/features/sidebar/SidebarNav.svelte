<script lang="ts">
  import { i18n } from '$lib/i18n';
  import { useRoomList } from '$lib/rooms/room-list.svelte';
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

  let { mobile = false, onNavigate, roomNavWidth = $bindable(224) }: Props = $props();
  const roomList = useRoomList();
  let dragging = $state(false);
  let drag: { pointerId: number; startX: number; startWidth: number } | undefined;
  let collapsed = $derived(roomNavWidth < COLLAPSED_ROOM_NAV_WIDTH);
  let spaces = $derived.by(() => {
    const childSpaceIds = roomList.rooms
      .filter((room) => room.is_space)
      .flatMap((space) => space.space_children.map((child) => child.room_id));

    return roomList.rooms.filter((room) => room.is_space && !childSpaceIds.includes(room.room_id));
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
  }

  function handleResizeKeydown(event: KeyboardEvent) {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;

    event.preventDefault();
    roomNavWidth = clampRoomNavWidth(
      roomNavWidth + (event.key === 'ArrowLeft' ? -ROOM_NAV_WIDTH_STEP : ROOM_NAV_WIDTH_STEP)
    );
  }
</script>

<aside class="sidebar">
  {#if mobile}
    <nav class="mobile-navigation" aria-label={$i18n.t('nav.primary')}>
      <div class="navigation-main">
        <NavigationRail {spaces} mobile {onNavigate} />
        <RoomNav {onNavigate} />
      </div>
      <UserQuickTools mobile {onNavigate} />
    </nav>
  {:else}
    <nav class="desktop-navigation" aria-label={$i18n.t('nav.primary')}>
      <div class="desktop-navigation-main">
        <NavigationRail {spaces} />
        <RoomNav width={roomNavWidth} {collapsed} />
        <button
          type="button"
          class="resize-handle"
          class:dragging
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

  @media (width >= 48rem) {
    .sidebar {
      height: 100dvh;
      left: 0;
      position: fixed;
      top: 0;
      width: calc(4.125rem + var(--room-nav-width));
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
    .resize-handle.dragging {
      background: var(--sable-primary-main);
    }

    .resize-handle:focus-visible {
      outline: var(--focus-ring-width) solid var(--sable-focus-ring);
      outline-offset: -3px;
    }
  }

  @media (width < 48rem) {
    .sidebar {
      height: 100%;
      width: 100%;
    }
  }
</style>
