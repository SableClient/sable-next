<script lang="ts">
  import { goto } from '$app/navigation';
  import { untrack, type Snippet } from 'svelte';
  import { page } from '$app/state';
  import { i18n } from '#lib/i18n.js';
  import BackIcon from 'phosphor-svelte/lib/CaretLeftIcon';
  import PanelHeader from '#lib/ui/primitives/PanelHeader.svelte';
  import PanelHeaderButton from '#lib/ui/primitives/PanelHeaderButton.svelte';
  import SidebarNav from '#lib/features/sidebar/SidebarNav.svelte';
  import UserQuickTools from '#lib/features/sidebar/UserQuickTools.svelte';
  import { providePageMeta } from '#lib/core/page-meta.js';
  import {
    finishSwipeGesture,
    startSwipeGesture,
    updateSwipeGesture,
    type SwipeGesture,
  } from './swipe-gesture';
  import { BREAKPOINTS } from './breakpoints';
  import { createMediaQuery } from './media-query.svelte';
  import { backToRoomList, goToPage, isRoomSwitch } from '#lib/features/room/room-navigation.js';
  import CoreHealthBanner from './CoreHealthBanner.svelte';

  interface Props {
    children: Snippet;
  }

  let { children }: Props = $props();

  type Gesture = SwipeGesture & { width: number };

  let position = $state<number | undefined>();
  let dragging = $state(false);
  let gesture: Gesture | undefined;
  let settleFrame: number | undefined;
  let routeFrame: number | undefined;
  let track: HTMLDivElement | undefined;
  let inertOpen = $state<boolean | undefined>();
  let inertTimer: ReturnType<typeof setTimeout> | undefined;
  let focusContentOnSettle = false;
  const appLayout = createMediaQuery(BREAKPOINTS.appLayout);
  /** Routes whose own index is the room list. Anywhere else the list would
      hide the page that was asked for behind an inert panel. Keyed on the path
      so room-list hydration cannot flash the sidebar over a room. */
  const LIST_INDEX_PATHS = new Set(['/home', '/rooms', '/direct']);
  const BLANK_INDEX_PATHS = new Set(['/home', '/rooms']);
  const MOBILE_QUICK_TOOLS_PATHS = new Set(['/navigate', '/inbox', '/profile', '/alerts']);
  let pathname = $derived(page.url.pathname);
  let settledPath = $state(page.url.pathname);
  let routeChanging = $derived(pathname !== settledPath && page.params.roomId === undefined);
  let spaceIndex = $derived(/^\/space\/[^/]+$/.test(pathname));
  let spaceLobby = $derived(/^\/space\/[^/]+\/lobby$/.test(pathname));
  let settingsPage = $derived(/^\/settings(\/[^/]+)?$/.test(pathname));
  let defaultOpen = $derived(LIST_INDEX_PATHS.has(pathname) || spaceIndex);
  let pinnedOpen = $derived(BLANK_INDEX_PATHS.has(pathname) || spaceIndex);
  let pinnedClosed = $derived(MOBILE_QUICK_TOOLS_PATHS.has(pathname));
  let showMobileQuickTools = $derived(MOBILE_QUICK_TOOLS_PATHS.has(pathname));
  let showMobileBackBar = $derived(
    !appLayout.matches &&
      !pinnedOpen &&
      !showMobileQuickTools &&
      !spaceLobby &&
      !settingsPage &&
      page.params.roomId === undefined
  );
  let open = $derived(
    pinnedClosed
      ? false
      : pinnedOpen ||
          (page.state.mobileDrawer === undefined ? defaultOpen : page.state.mobileDrawer === 'open')
  );
  let panelsOpen = $derived(inertOpen ?? open);

  function settleInert() {
    clearTimeout(inertTimer);
    inertTimer = undefined;
    inertOpen = open;
    if (!focusContentOnSettle || open) return;
    focusContentOnSettle = false;
    requestAnimationFrame(() => {
      document.getElementById('main-content')?.focus();
    });
  }

  $effect(() => {
    const next = open;
    const current = untrack(() => inertOpen);
    if (current === next) return;
    const duration =
      current === undefined || !track
        ? 0
        : parseFloat(getComputedStyle(track).transitionDuration) * 1000;
    if (!duration) {
      settleInert();
      return;
    }
    inertTimer = setTimeout(settleInert, duration + 100);
    return () => {
      clearTimeout(inertTimer);
    };
  });

  const pageMeta = $state({
    title: '',
  });
  providePageMeta(pageMeta);
  let pageTitle = $derived(pageMeta.title);

  // Navigating out from under a drag would otherwise leave the track pinned at
  // the gesture's last offset.
  $effect(() => {
    const next = pathname;
    cancelSettling();
    if (routeFrame !== undefined) cancelAnimationFrame(routeFrame);
    routeFrame = requestAnimationFrame(() => {
      routeFrame = requestAnimationFrame(() => {
        settledPath = next;
        routeFrame = undefined;
      });
    });
    position = undefined;
    dragging = false;
    gesture = undefined;
    return () => {
      if (routeFrame !== undefined) cancelAnimationFrame(routeFrame);
    };
  });

  function cancelSettling() {
    if (settleFrame === undefined) return;

    cancelAnimationFrame(settleFrame);
    settleFrame = undefined;
  }

  function settleDrawer() {
    dragging = false;
    // Give the browser a rendered frame with transitions enabled before
    // releasing the drag offset to the open or closed transform.
    settleFrame = requestAnimationFrame(() => {
      settleFrame = requestAnimationFrame(() => {
        position = undefined;
        settleFrame = undefined;
      });
    });
  }

  function setOpen(next: boolean): void {
    if (next === open || (!next && pinnedOpen)) return;
    void goto('', {
      shallow: true,
      replace: true,
      state: { ...page.state, mobileDrawer: next ? 'open' : 'closed' },
    });
    if (!next) {
      focusContentOnSettle = true;
      return;
    }
    requestAnimationFrame(() => {
      document.getElementById('drawer-toggle')?.focus();
    });
  }

  function handleTouchStart(event: TouchEvent) {
    cancelSettling();
    if (appLayout.matches) return;
    const target = event.currentTarget;
    if (!(target instanceof HTMLDivElement)) return;

    const width = target.clientWidth;
    if (width === 0) return;

    const swipe = startSwipeGesture(event, open ? 0 : -width);
    if (!swipe) return;

    if (pinnedClosed) return;

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
        setOpen(true);
      } else if (result.direction === 'left') {
        setOpen(false);
      } else {
        setOpen(currentPosition > -activeGesture.width / 2);
      }
    }

    settleDrawer();
  }

  function revealCurrentPage(event: MouseEvent) {
    if (appLayout.matches || !(event.target instanceof Element)) return;
    const link = event.target.closest('a[href]');
    if (!(link instanceof HTMLAnchorElement)) return;
    if (link.pathname === pathname) {
      event.preventDefault();
      setOpen(false);
      return;
    }
    const plain =
      event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey;
    if (plain && isRoomSwitch(link.href)) {
      event.preventDefault();
      goToPage(link.href);
    }
  }

  function handleKeydown(event: KeyboardEvent) {
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      setOpen(false);
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      setOpen(true);
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
    id="drawer-toggle"
    class="screen-reader-only"
    type="button"
    aria-label={open ? $i18n.t('nav.showConversation') : $i18n.t('nav.showRoomList')}
    aria-pressed={open}
    aria-describedby="drawer-instructions"
    onclick={() => {
      setOpen(!open);
    }}
    onkeydown={handleKeydown}
  ></button>
  <p id="drawer-instructions" class="screen-reader-only">
    {$i18n.t('nav.mobilePanelInstructions')}
  </p>
  <div
    bind:this={track}
    class="drawer-track"
    class:open
    class:dragging
    class:route-changing={routeChanging}
    style:transform={position === undefined
      ? undefined
      : `translate3d(${String(position)}px, 0, 0)`}
    ontransitionend={(event) => {
      if (event.target !== event.currentTarget || event.propertyName !== 'transform') return;
      if (inertTimer !== undefined) settleInert();
    }}
  >
    <!-- svelte-ignore a11y_click_events_have_key_events, a11y_no_static_element_interactions -->
    <section
      class="drawer-panel navigation-panel"
      inert={!panelsOpen || appLayout.matches}
      onclick={revealCurrentPage}
    >
      {#if !appLayout.matches}
        <SidebarNav mobile />
      {/if}
    </section>
    <section
      class="drawer-panel content-panel"
      class:with-quick-tools={showMobileQuickTools}
      class:with-back-bar={showMobileBackBar}
      inert={panelsOpen && !appLayout.matches}
    >
      <CoreHealthBanner />
      {#if showMobileBackBar}
        <PanelHeader class="mobile-back-bar" title={pageTitle}>
          {#snippet prefix()}
            <PanelHeaderButton
              class="back-button"
              label={$i18n.t('timeline.back')}
              onclick={backToRoomList}
            >
              <BackIcon />
            </PanelHeaderButton>
          {/snippet}
        </PanelHeader>
      {/if}
      <div id="main-content" class="content" tabindex="-1">
        {@render children()}
      </div>
      {#if !appLayout.matches}
        <div class="mobile-quick-tools"><UserQuickTools mobile /></div>
      {/if}
    </section>
  </div>
</div>

<style>
  .drawer-viewport {
    height: 100%;
    overflow: clip;
    touch-action: pan-y;
  }

  .drawer-track {
    display: flex;
    height: 100%;
    transform: translateX(-50%);
    width: 200%;
    will-change: transform;
  }

  .drawer-track.open {
    transform: translateX(0);
  }

  .drawer-panel {
    --edge-inset-top: var(--safe-top);
    --edge-inset-bottom: max(0px, calc(var(--safe-bottom) - var(--keyboard-overlap)));

    display: flex;
    flex: 0 0 50%;
    height: 100%;
    min-width: 0;
    overflow: hidden;
    padding: var(--safe-top) var(--safe-right) var(--safe-bottom) var(--safe-left);
    width: 50%;
  }

  .navigation-panel {
    background: var(--bg-container);
    color: var(--bg-on-container);
  }

  .content-panel {
    background: var(--surface-container);
    color: var(--surface-on-container);
    flex-direction: column;
  }

  .content {
    display: flex;
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }

  .mobile-quick-tools {
    flex: 0 0 auto;
    height: 0;
    visibility: collapse;
  }

  .content-panel.with-quick-tools .mobile-quick-tools {
    height: auto;
    visibility: visible;
  }

  .content-panel:not(.with-quick-tools) :global(.app-page-shell .app-page-header h1) {
    height: 0;
    visibility: collapse;
  }

  @media (width < 48rem) {
    .navigation-panel,
    .content-panel.with-quick-tools,
    .content-panel:has(> .content > :global([data-inset-owner~='bottom'])) {
      padding-bottom: calc(var(--safe-bottom) - var(--edge-inset-bottom));
    }

    .content-panel.with-back-bar,
    .content-panel:has(> .content > :global([data-inset-owner~='top'])) {
      padding-top: 0;
    }
  }

  @media (prefers-reduced-motion: no-preference) {
    :global(html:not([data-reduced-motion='on'])) .drawer-track:not(.dragging, .route-changing) {
      transition: transform var(--duration-medium) var(--ease-slide);
    }
  }

  @media (width >= 48rem) {
    .mobile-quick-tools {
      display: none;
    }

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
      --edge-inset-top: 0px;
      --edge-inset-bottom: 0px;

      flex-basis: 100%;
      width: 100%;
    }
  }
</style>
