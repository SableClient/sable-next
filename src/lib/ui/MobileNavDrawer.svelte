<script lang="ts">
  import type { Snippet } from 'svelte';
  import { page } from '$app/state';
  import { i18n } from '$lib/i18n';
  import SidebarNav from '$lib/features/sidebar/SidebarNav.svelte';
  import {
    finishSwipeGesture,
    startSwipeGesture,
    updateSwipeGesture,
    type SwipeGesture,
  } from './swipe-gesture';
  import { BREAKPOINTS } from './breakpoints';
  import { createMediaQuery } from './media-query.svelte';

  interface Props {
    children: Snippet;
  }

  let { children }: Props = $props();

  type Gesture = SwipeGesture & { width: number };

  let position = $state<number | undefined>();
  let dragging = $state(false);
  let gesture: Gesture | undefined;
  const appLayout = createMediaQuery(BREAKPOINTS.appLayout);
  /** Routes whose own index is the room list. Anywhere else the list would
      hide the page that was asked for behind an inert panel. Keyed on the path
      so room-list hydration cannot flash the sidebar over a room. */
  const LIST_INDEX_PATHS = new Set(['/home', '/direct']);
  let pathname = $derived(page.url.pathname);
  let open = $derived(LIST_INDEX_PATHS.has(pathname) || /^\/space\/[^/]+$/.test(pathname));

  // Navigating out from under a drag would otherwise leave the track pinned at
  // the gesture's last offset.
  $effect(() => {
    void pathname;
    position = undefined;
    dragging = false;
    gesture = undefined;
  });

  function handleTouchStart(event: TouchEvent) {
    const target = event.currentTarget;
    if (!(target instanceof HTMLDivElement)) return;

    const width = target.clientWidth;
    if (width === 0) return;

    const swipe = startSwipeGesture(event, open ? 0 : -width);
    if (!swipe) return;
    gesture = { ...swipe, width };
  }

  function handleTouchMove(event: TouchEvent) {
    if (!gesture) return;

    const update = updateSwipeGesture(gesture, event);
    if (!update || update.mode !== 'horizontal') return;

    if (!dragging) {
      dragging = true;
    }
    position = Math.max(-gesture.width, Math.min(0, gesture.startPosition + update.distanceX));
  }

  function finishGesture(cancelled: boolean) {
    const activeGesture = gesture;
    gesture = undefined;
    if (!activeGesture || activeGesture.mode !== 'horizontal') {
      dragging = false;
      position = undefined;
      return;
    }

    const currentPosition = position ?? activeGesture.startPosition;
    const result = finishSwipeGesture(activeGesture, currentPosition, cancelled);
    if (result.handled) {
      if (result.direction === 'right') {
        open = true;
      } else if (result.direction === 'left') {
        open = false;
      } else {
        open = currentPosition > -activeGesture.width / 2;
      }
    }

    dragging = false;
    position = undefined;
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      open = false;
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      open = true;
    }
  }
</script>

<div
  class="drawer-viewport"
  role="group"
  aria-label={$i18n.t('nav.primary')}
  ontouchstart={handleTouchStart}
  ontouchmove={handleTouchMove}
  ontouchend={() => {
    finishGesture(false);
  }}
  ontouchcancel={() => {
    finishGesture(true);
  }}
>
  <button
    class="screen-reader-only"
    type="button"
    aria-label={open ? $i18n.t('nav.showConversation') : $i18n.t('nav.showRoomList')}
    aria-pressed={open}
    aria-describedby="drawer-instructions"
    onclick={() => {
      open = !open;
    }}
    onkeydown={handleKeydown}
  ></button>
  <p id="drawer-instructions" class="screen-reader-only">
    {$i18n.t('nav.mobilePanelInstructions')}
  </p>
  <div
    class="drawer-track"
    class:open
    class:dragging
    style:transform={position === undefined
      ? undefined
      : `translate3d(${String(position)}px, 0, 0)`}
  >
    <section class="drawer-panel navigation-panel" inert={!open || appLayout.matches}>
      <SidebarNav mobile />
    </section>
    <section class="drawer-panel content-panel" inert={open && !appLayout.matches}>
      <div class="content">
        {@render children()}
      </div>
    </section>
  </div>
</div>

<style>
  .drawer-viewport {
    height: 100dvh;
    overflow: hidden;
    touch-action: pan-y;
  }

  .drawer-track {
    display: flex;
    height: 100%;
    transform: translateX(-50%);
    width: 200%;
  }

  .drawer-track.open {
    transform: translateX(0);
  }

  .drawer-panel {
    display: flex;
    flex: 0 0 50%;
    height: 100%;
    min-width: 0;
    overflow: hidden;
    width: 50%;
  }

  .navigation-panel {
    background: var(--sable-bg-container);
  }

  .content-panel {
    flex-direction: column;
  }

  .content {
    background: var(--sable-surface-container);
    display: flex;
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }

  @media (prefers-reduced-motion: no-preference) {
    .drawer-track:not(.dragging) {
      transition: transform 220ms cubic-bezier(0.33, 1, 0.68, 1);
    }
  }

  @media (width >= 48rem) {
    .drawer-viewport {
      margin-left: calc(var(--navigation-rail-width) + var(--room-nav-width));
    }

    .screen-reader-only,
    .navigation-panel {
      display: none;
    }

    .drawer-track,
    .drawer-track.open {
      transform: none;
      width: 100%;
    }

    .drawer-panel,
    .content-panel {
      flex-basis: 100%;
      width: 100%;
    }
  }
</style>
