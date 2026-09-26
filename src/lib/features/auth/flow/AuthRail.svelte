<script lang="ts">
  import { untrack, type Snippet } from 'svelte';
  import CaretLeftIcon from 'phosphor-svelte/lib/CaretLeftIcon';
  import CaretRightIcon from 'phosphor-svelte/lib/CaretRightIcon';
  import { cubicOut } from 'svelte/easing';
  import { i18n } from '#lib/i18n.js';
  import { MOTION_MS, motionMs } from '#lib/ui/motion.js';
  import {
    finishSwipeGesture,
    startSwipeGesture,
    updateSwipeGesture,
    type SwipeGesture,
  } from '#lib/ui/swipe-gesture.js';

  interface Props {
    activeIndex: number;
    total: number;
    canBack: boolean;
    canForward: boolean;
    onBack: () => void;
    onForward: () => void;
    progress?: string;
    children: Snippet;
  }

  let { activeIndex, total, canBack, canForward, onBack, onForward, progress, children }: Props =
    $props();
  let railElement = $state<HTMLDivElement>();
  let motionReady = $state(false);
  let activeCardHeight = $state<number | null>(null);
  let isNavigating = $state(false);
  let lastActiveIndex: number | null = null;
  let scrollTimer: number | undefined;
  let leavingCard: HTMLElement | undefined;
  let scrollAnimation: number | undefined;
  let motionReadyFrame: number | undefined;
  let isDragging = $state(false);
  let swipeGesture: SwipeGesture | undefined;
  let swipeStartScroll = 0;
  let swipeOffset = 0;

  function cardTarget(rail: HTMLDivElement, card: HTMLElement): number {
    return Math.max(0, card.offsetLeft - (rail.clientWidth - card.offsetWidth) / 2);
  }

  function animateToCard(rail: HTMLDivElement, card: HTMLElement): void {
    window.cancelAnimationFrame(scrollAnimation ?? 0);
    isNavigating = false;
    const start = rail.scrollLeft;
    const target = cardTarget(rail, card);
    const distance = target - start;
    const duration = motionMs(MOTION_MS.fast);

    if (duration === 0 || Math.abs(distance) < 1) {
      rail.scrollLeft = target;
      return;
    }

    isNavigating = true;
    const startedAt = performance.now();
    const frame = (now: number) => {
      const progress = Math.min(1, (now - startedAt) / duration);
      const eased = cubicOut(progress);
      rail.scrollLeft = start + distance * eased;
      if (progress < 1) {
        scrollAnimation = window.requestAnimationFrame(frame);
      } else {
        rail.scrollLeft = target;
        isNavigating = false;
      }
    };
    scrollAnimation = window.requestAnimationFrame(frame);
  }

  function scrollBounds(rail: HTMLDivElement): [number, number] {
    const maxScroll = Math.max(0, rail.scrollWidth - rail.clientWidth);
    const card = cardElements(rail)[activeIndex] as HTMLElement | undefined;
    const here = card ? cardTarget(rail, card) : rail.scrollLeft;
    return [canBack ? 0 : here, canForward ? maxScroll : here];
  }

  function handleScroll(): void {
    if (isDragging || isNavigating || swipeGesture) return;
    const rail = railElement;
    if (rail) {
      const [min, max] = scrollBounds(rail);
      if (rail.scrollLeft < min - 1 || rail.scrollLeft > max + 1) {
        rail.scrollLeft = Math.max(min, Math.min(max, rail.scrollLeft));
        return;
      }
    }
    window.clearTimeout(scrollTimer);
    scrollTimer = window.setTimeout(activateNearestCard, 120);
  }

  function cardElements(rail: HTMLDivElement): HTMLElement[] {
    return [...rail.querySelectorAll<HTMLElement>(':scope > .auth-card')];
  }

  function settleToCard(index: number): void {
    const rail = railElement;
    if (!rail) return;

    const cards = cardElements(rail);
    if (index < 0 || index >= cards.length) return;
    animateToCard(rail, cards[index]);
  }

  function handleTouchStart(event: TouchEvent): void {
    const rail = railElement;
    if (!rail || isNavigating) return;
    if (!(event.target instanceof Element) || !event.target.closest('.auth-card')) return;

    const gesture = startSwipeGesture(event, 0);
    if (!gesture) return;

    window.clearTimeout(scrollTimer);
    window.cancelAnimationFrame(scrollAnimation ?? 0);
    scrollAnimation = undefined;
    isNavigating = false;
    swipeGesture = gesture;
    swipeStartScroll = rail.scrollLeft;
    swipeOffset = 0;
  }

  function handleTouchMove(event: TouchEvent): void {
    const rail = railElement;
    const gesture = swipeGesture;
    if (!rail || !gesture) return;

    const update = updateSwipeGesture(gesture, event);
    if (!update || update.mode !== 'horizontal') return;

    isDragging = true;
    swipeOffset = update.distanceX;
    const [min, max] = scrollBounds(rail);
    rail.scrollLeft = Math.max(min, Math.min(max, swipeStartScroll - swipeOffset));
  }

  function finishTouchGesture(cancelled: boolean): void {
    const rail = railElement;
    const gesture = swipeGesture;
    if (!rail || !gesture) return;

    swipeGesture = undefined;
    const wasDragging = isDragging;
    const result = finishSwipeGesture(gesture, swipeOffset, cancelled);
    isDragging = false;
    swipeOffset = 0;

    if (!wasDragging) return;
    if (!result.handled) {
      settleToCard(activeIndex);
      return;
    }

    let targetIndex: number | undefined;
    if (result.direction === 'left' && canForward) targetIndex = activeIndex + 1;
    if (result.direction === 'right' && canBack) targetIndex = activeIndex - 1;

    if (targetIndex === undefined || !cardElements(rail)[targetIndex]) {
      settleToCard(activeIndex);
      return;
    }

    settleToCard(targetIndex);
    if (targetIndex > activeIndex) onForward();
    else onBack();
  }

  function activateNearestCard(): void {
    const rail = railElement;
    if (!rail) return;
    const railCenter = rail.scrollLeft + rail.clientWidth / 2;
    const cards = cardElements(rail);
    const nearestIndex = cards.reduce((nearest, card, index) => {
      const center = card.offsetLeft + card.offsetWidth / 2;
      const nearestCard = cards[nearest];
      const nearestCenter = nearestCard.offsetLeft + nearestCard.offsetWidth / 2;
      return Math.abs(center - railCenter) < Math.abs(nearestCenter - railCenter) ? index : nearest;
    }, 0);

    if (nearestIndex < activeIndex && canBack) onBack();
    else if (nearestIndex > activeIndex && canForward) onForward();
    else settleToCard(activeIndex);
  }

  $effect(() => {
    const rail = railElement;
    if (!rail) return;
    const observer = new ResizeObserver(() => {
      if (isDragging || isNavigating || swipeGesture) return;
      const card = cardElements(rail)[untrack(() => activeIndex)] as HTMLElement | undefined;
      if (card) rail.scrollLeft = cardTarget(rail, card);
    });
    observer.observe(rail);
    return () => {
      observer.disconnect();
    };
  });

  $effect(() => {
    const index = activeIndex;
    const rail = railElement;
    if (!rail) return;

    const cards = rail.querySelectorAll<HTMLElement>(':scope > .auth-card');
    if (index < 0 || index >= cards.length) return;
    const card = cards.item(index);
    const sizeObserver = new ResizeObserver(() => {
      activeCardHeight = card.offsetHeight;
    });
    activeCardHeight = card.offsetHeight;
    sizeObserver.observe(card);
    const shouldFocus = lastActiveIndex !== null && lastActiveIndex !== index;
    leavingCard?.removeAttribute('data-leaving');
    leavingCard =
      lastActiveIndex === null || lastActiveIndex === index
        ? undefined
        : cards.item(lastActiveIndex);
    leavingCard?.setAttribute('data-leaving', '');
    lastActiveIndex = index;

    if (motionReady) {
      animateToCard(rail, card);
    } else {
      rail.scrollLeft = cardTarget(rail, card);
      motionReadyFrame = window.requestAnimationFrame(() => {
        motionReady = true;
      });
    }

    if (shouldFocus) {
      const heading = card.querySelector<HTMLElement>('h1, h2, h3');
      heading?.setAttribute('tabindex', '-1');
      const focusTarget = heading ?? card.querySelector<HTMLElement>('input, button, [tabindex]');
      focusTarget?.focus({ preventScroll: true });
    }

    return () => {
      sizeObserver.disconnect();
      window.cancelAnimationFrame(scrollAnimation ?? 0);
      window.cancelAnimationFrame(motionReadyFrame ?? 0);
      window.clearTimeout(scrollTimer);
    };
  });
</script>

{#if progress}
  <div
    class="rail-progress"
    role="progressbar"
    aria-label={$i18n.t('setup.title')}
    aria-valuemin="1"
    aria-valuemax={total}
    aria-valuenow={activeIndex + 1}
    aria-valuetext={progress}
    style:--progress={`${((activeIndex + 1) / total) * 100}%`}
  ></div>
{/if}
<div class="rail-shell">
  {#if total > 1}
    <nav class="mobile-nav" aria-label={$i18n.t('auth.stageNavigation')}>
      {#if canBack}
        <button
          class="panel-nav previous"
          type="button"
          onclick={onBack}
          aria-label={$i18n.t('auth.back')}><CaretLeftIcon /></button
        >
      {/if}
      {#if canForward}
        <button
          class="panel-nav next"
          type="button"
          onclick={onForward}
          aria-label={$i18n.t('auth.next')}><CaretRightIcon /></button
        >
      {/if}
    </nav>
  {/if}
  <div
    bind:this={railElement}
    class="rail"
    class:motion-ready={motionReady}
    class:is-navigating={isNavigating}
    class:is-dragging={isDragging}
    style:height={activeCardHeight === null
      ? undefined
      : `calc(${activeCardHeight}px + var(--space-100) + var(--space-400))`}
    style:--active-card-height={activeCardHeight === null ? undefined : `${activeCardHeight}px`}
    role="group"
    aria-label={$i18n.t('auth.stageNavigation')}
    ontouchstart={handleTouchStart}
    ontouchmove={handleTouchMove}
    ontouchend={() => {
      finishTouchGesture(false);
    }}
    ontouchcancel={() => {
      finishTouchGesture(true);
    }}
    onscroll={handleScroll}
  >
    {@render children()}
  </div>
</div>

<style>
  .rail-progress {
    background: var(--surface-var-container);
    border-radius: var(--radii-pill);
    height: var(--space-100);
    margin: 0 auto var(--space-400);
    max-width: 12rem;
    overflow: hidden;
  }

  .rail-progress::before {
    background: var(--primary-main);
    border-radius: inherit;
    content: '';
    display: block;
    height: 100%;
    width: var(--progress);
  }

  .rail-shell {
    --auth-card-width: min(24rem, calc(100vw - 3rem));
    --auth-rail-edge-fade: 1.5rem;

    isolation: isolate;
    min-width: 0;
    position: relative;
    width: 100%;
  }

  .rail-shell::before,
  .rail-shell::after {
    background: linear-gradient(90deg, var(--bg-container), transparent);
    content: '';
    inset-block: 0;
    pointer-events: none;
    position: absolute;
    width: var(--auth-rail-edge-fade);
    z-index: 3;
  }

  .rail-shell::before {
    left: 0;
  }

  .rail-shell::after {
    background: linear-gradient(270deg, var(--bg-container), transparent);
    right: 0;
  }

  .rail {
    align-items: start;
    box-sizing: border-box;
    display: flex;
    gap: var(--space-800);
    margin-inline: auto;
    overflow: auto hidden;
    overscroll-behavior-inline: contain;
    padding: var(--space-100) max(var(--space-100), calc((100% - var(--auth-card-width)) / 2))
      var(--space-400);
    pointer-events: none;
    position: relative;
    scroll-padding-inline: calc((100% - var(--auth-card-width)) / 2);
    scroll-snap-type: x proximity;
    scrollbar-width: none;
    width: 100%;
    z-index: 1;
  }

  .rail::-webkit-scrollbar {
    display: none;
  }

  .rail.is-navigating {
    scroll-snap-type: none;
  }

  .rail.is-dragging {
    scroll-snap-type: none;
  }

  .rail :global(.auth-card) {
    flex: 0 0 var(--auth-card-width);
    pointer-events: auto;
    position: relative;
    scroll-snap-align: center;
    z-index: 2;
  }

  .rail.motion-ready :global(.auth-card) {
    transition:
      opacity var(--duration-fast) var(--ease-smooth-out),
      transform var(--duration-fast) var(--ease-smooth-out);
  }

  .rail :global(.auth-card.before),
  .rail :global(.auth-card.after) {
    mask-image: linear-gradient(black 75%, transparent);
    max-height: var(--active-card-height, none);
    opacity: 0.45;
    overflow: hidden;
    transform: scale(var(--scale-subtle));
  }

  .rail :global(.auth-card.removing) {
    opacity: 0;
    pointer-events: none;
    transform: translateX(var(--space-200)) scale(var(--scale-subtle));
  }

  .rail :global(.auth-card.before) {
    transform: translateX(calc(var(--space-150) * -1)) scale(var(--scale-subtle));
  }

  .rail :global(.auth-card.after) {
    transform: translateX(var(--space-150)) scale(var(--scale-subtle));
  }

  .rail :global(.auth-card.active) {
    opacity: 1;
    transform: translateX(0) scale(1);
  }

  .rail.motion-ready :global(.auth-card.entering) {
    animation: card-enter var(--duration-fast) var(--ease-smooth-out) both;
  }

  @keyframes card-enter {
    from {
      opacity: 0;
    }
  }

  .mobile-nav {
    display: block;
    inset: 0;
    pointer-events: none;
    position: fixed;
    z-index: 0;
  }

  .panel-nav {
    align-items: center;
    background: transparent;
    border: 0;
    color: var(--sec-main);
    cursor: pointer;
    display: flex;
    height: 2.25rem;
    justify-content: center;
    padding: 0;
    pointer-events: auto;
    position: absolute;
    top: 50%;
    transform: translateY(-50%);
    width: 2.25rem;
  }

  .panel-nav:focus-visible {
    box-shadow: 0 0 0 var(--focus-ring-width) var(--focus-ring);
    outline: none;
  }

  .panel-nav:hover {
    color: var(--bg-on-container);
  }

  @media (prefers-reduced-motion: no-preference) {
    :global(html:not([data-reduced-motion='on'])) .panel-nav {
      transition:
        color var(--motion-normal) var(--motion-easing-standard),
        transform var(--motion-normal) var(--motion-easing-standard);
    }

    :global(html:not([data-reduced-motion='on'])) .panel-nav:hover {
      transform: translateY(-50%) scale(1.05);
    }
  }

  .panel-nav :global(svg) {
    height: var(--icon-size-medium);
    width: var(--icon-size-medium);
  }

  .panel-nav.previous {
    left: calc(50vw - var(--auth-card-width) / 2 - 2.625rem);
  }

  .panel-nav.next {
    right: calc(50vw - var(--auth-card-width) / 2 - 2.625rem);
  }

  @media (prefers-reduced-motion: reduce) {
    .rail.motion-ready :global(.auth-card) {
      transition: none;
    }

    .rail.motion-ready :global(.auth-card.entering) {
      animation: none;
    }

    .panel-nav {
      transition: none;
    }

    .panel-nav:hover {
      transform: translateY(-50%);
    }
  }

  :global(html[data-reduced-motion='on']) .rail.motion-ready :global(.auth-card) {
    transition: none;
  }

  :global(html[data-reduced-motion='on']) .rail.motion-ready :global(.auth-card.entering) {
    animation: none;
  }

  @media (width <= 48rem) {
    .rail-shell {
      --auth-card-width: min(24rem, calc(100vw - 5rem));
    }

    .rail {
      scroll-snap-type: x mandatory;
      touch-action: pan-y;
    }
  }
</style>
