<script lang="ts">
  import type { Snippet } from 'svelte';
  import { page } from '$app/state';
  import { i18n } from '$lib/i18n';
  import SidebarNav from '$lib/features/sidebar/SidebarNav.svelte';

  interface Props {
    children: Snippet;
  }

  let { children }: Props = $props();

  function isNavigationRoute(pathname: string) {
    return (
      pathname === '/home' ||
      pathname === '/direct' ||
      pathname === '/explore' ||
      pathname === '/navigate' ||
      /^\/space\/[^/]+$/.test(pathname)
    );
  }

  const SWIPE_THRESHOLD = 64;
  const VELOCITY_THRESHOLD = 0.3;

  type Gesture = {
    startX: number;
    startY: number;
    startPosition: number;
    width: number;
    lastX: number;
    lastTime: number;
    velocityX: number;
    mode: 'pending' | 'drawer' | 'vertical';
  };

  let open = $state(isNavigationRoute(page.url.pathname));
  let position = $state<number | undefined>();
  let dragging = $state(false);
  let gesture: Gesture | undefined;

  $effect(() => {
    open = isNavigationRoute(page.url.pathname);
    position = undefined;
    dragging = false;
    gesture = undefined;
  });

  function handleTouchStart(event: TouchEvent) {
    if (event.touches.length !== 1) return;

    const target = event.currentTarget;
    if (!(target instanceof HTMLDivElement)) return;

    const touch = event.touches[0];
    const width = target.clientWidth;
    if (width === 0) return;

    gesture = {
      startX: touch.clientX,
      startY: touch.clientY,
      startPosition: open ? 0 : -width,
      width,
      lastX: touch.clientX,
      lastTime: event.timeStamp,
      velocityX: 0,
      mode: 'pending',
    };
  }

  function handleTouchMove(event: TouchEvent) {
    const touch = event.touches[0];
    if (!gesture || event.touches.length !== 1) return;

    const distanceX = touch.clientX - gesture.startX;
    const distanceY = touch.clientY - gesture.startY;
    const elapsed = event.timeStamp - gesture.lastTime;
    if (elapsed > 0) {
      gesture.velocityX = (touch.clientX - gesture.lastX) / elapsed;
      gesture.lastX = touch.clientX;
      gesture.lastTime = event.timeStamp;
    }

    if (gesture.mode === 'pending') {
      if (distanceX === 0 && distanceY === 0) return;
      if (Math.abs(distanceX) <= Math.abs(distanceY)) {
        gesture.mode = 'vertical';
        return;
      }
      gesture.mode = 'drawer';
      dragging = true;
    }

    if (gesture.mode !== 'drawer') return;
    position = Math.max(-gesture.width, Math.min(0, gesture.startPosition + distanceX));
  }

  function finishGesture(cancelled: boolean) {
    const activeGesture = gesture;
    gesture = undefined;
    if (!activeGesture || activeGesture.mode !== 'drawer') return;

    const currentPosition = position ?? activeGesture.startPosition;
    const distanceX = currentPosition - activeGesture.startPosition;
    if (!cancelled) {
      if (activeGesture.velocityX > VELOCITY_THRESHOLD) {
        open = true;
      } else if (activeGesture.velocityX < -VELOCITY_THRESHOLD) {
        open = false;
      } else if (Math.abs(distanceX) >= SWIPE_THRESHOLD) {
        open = distanceX > 0;
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
    aria-label={open ? 'Close navigation' : 'Open navigation'}
    aria-pressed={open}
    aria-describedby="drawer-instructions"
    onclick={() => {
      open = !open;
    }}
    onkeydown={handleKeydown}
  ></button>
  <p id="drawer-instructions" class="screen-reader-only">
    Swipe right to show navigation or left to show content. Use the left and right arrow keys to
    switch panels.
  </p>
  <div
    class="drawer-track"
    class:open
    class:dragging
    style:transform={position === undefined
      ? undefined
      : `translate3d(${String(position)}px, 0, 0)`}
  >
    <section class="drawer-panel navigation-panel" inert={!open}>
      <SidebarNav mobile />
    </section>
    <section class="drawer-panel content-panel" inert={open}>
      <main class="content">
        {@render children()}
      </main>
    </section>
  </div>
</div>

<style>
  .drawer-viewport {
    height: 100dvh;
    overflow: hidden;
    touch-action: pan-y;
  }

  .screen-reader-only {
    height: 1px;
    margin: -1px;
    overflow: hidden;
    padding: 0;
    position: absolute;
    white-space: nowrap;
    width: 1px;
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
</style>
