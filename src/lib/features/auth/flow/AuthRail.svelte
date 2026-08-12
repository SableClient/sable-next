<script lang="ts">
  import type { Snippet } from 'svelte';
  import { prefersReducedMotion } from 'svelte/motion';
  import CaretLeftIcon from 'phosphor-icons-svelte/IconCaretLeftRegular.svelte';
  import CaretRightIcon from 'phosphor-icons-svelte/IconCaretRightRegular.svelte';
  import { cubicOut } from 'svelte/easing';
  import { i18n } from '$lib/i18n';
  import { AUTH_CARD_MOTION_MS } from './auth-flow.svelte';

  interface Props {
    activeIndex: number;
    total: number;
    canBack: boolean;
    canForward: boolean;
    onBack: () => void;
    onForward: () => void;
    children: Snippet;
  }

  let { activeIndex, total, canBack, canForward, onBack, onForward, children }: Props = $props();
  let railElement = $state<HTMLDivElement>();
  let motionReady = $state(false);
  let isNavigating = $state(false);
  let lastActiveIndex: number | null = null;
  let scrollTimer: number | undefined;
  let scrollAnimation: number | undefined;

  function cardTarget(rail: HTMLDivElement, card: HTMLElement): number {
    return Math.max(0, card.offsetLeft - (rail.clientWidth - card.offsetWidth) / 2);
  }

  function animateToCard(rail: HTMLDivElement, card: HTMLElement): void {
    window.cancelAnimationFrame(scrollAnimation ?? 0);
    isNavigating = false;
    const start = rail.scrollLeft;
    const target = cardTarget(rail, card);
    const distance = target - start;
    const duration = prefersReducedMotion.current ? 0 : AUTH_CARD_MOTION_MS;

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

  function handleScroll(): void {
    if (!window.matchMedia('(width <= 48rem)').matches) return;
    window.clearTimeout(scrollTimer);
    scrollTimer = window.setTimeout(activateNearestCard, 120);
  }

  function activateNearestCard(): void {
    const rail = railElement;
    if (!rail) return;
    const railCenter = rail.scrollLeft + rail.clientWidth / 2;
    const cards = [...rail.querySelectorAll<HTMLElement>(':scope > .auth-card')];
    const nearestIndex = cards.reduce((nearest, card, index) => {
      const center = card.offsetLeft + card.offsetWidth / 2;
      const nearestCard = cards[nearest];
      const nearestCenter = nearestCard.offsetLeft + nearestCard.offsetWidth / 2;
      return Math.abs(center - railCenter) < Math.abs(nearestCenter - railCenter) ? index : nearest;
    }, 0);

    if (nearestIndex < activeIndex && canBack) onBack();
    if (nearestIndex > activeIndex && canForward) onForward();
  }

  $effect(() => {
    const index = activeIndex;
    const rail = railElement;
    if (!rail) return;

    const cards = rail.querySelectorAll<HTMLElement>(':scope > .auth-card');
    if (index < 0 || index >= cards.length) return;
    const card = cards.item(index);
    const shouldFocus = lastActiveIndex !== null && lastActiveIndex !== index;
    lastActiveIndex = index;

    if (motionReady) {
      animateToCard(rail, card);
    } else {
      rail.scrollLeft = cardTarget(rail, card);
      window.requestAnimationFrame(() => {
        motionReady = true;
      });
    }

    if (shouldFocus) {
      const heading = card.querySelector<HTMLElement>('h1, h2, h3');
      heading?.setAttribute('tabindex', '-1');
      const focusTarget = heading ?? card.querySelector<HTMLElement>('input, button, [tabindex]');
      focusTarget?.focus({ preventScroll: true });
    }
  });
</script>

<div class="rail-shell" style:--auth-card-motion-duration={`${String(AUTH_CARD_MOTION_MS)}ms`}>
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
    aria-live="polite"
    onscroll={handleScroll}
  >
    {@render children()}
  </div>
</div>

<style>
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
    background: linear-gradient(90deg, var(--sable-bg-container), transparent);
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
    background: linear-gradient(270deg, var(--sable-bg-container), transparent);
    right: 0;
  }

  .rail {
    align-items: start;
    box-sizing: border-box;
    display: flex;
    gap: 3rem;
    margin-inline: auto;
    overflow-x: auto;
    overscroll-behavior-inline: contain;
    padding: 0.25rem max(0.25rem, calc((100% - var(--auth-card-width)) / 2)) 1rem;
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

  .rail :global(.auth-card) {
    flex: 0 0 var(--auth-card-width);
    pointer-events: auto;
    position: relative;
    scroll-snap-align: center;
    z-index: 2;
  }

  .rail.motion-ready :global(.auth-card) {
    transition:
      filter var(--auth-card-motion-duration) var(--motion-easing-emphasized),
      opacity var(--auth-card-motion-duration) var(--motion-easing-emphasized),
      transform var(--auth-card-motion-duration) var(--motion-easing-emphasized);
  }

  .rail :global(.auth-card.before),
  .rail :global(.auth-card.after) {
    filter: brightness(0.7) saturate(0.55);
    opacity: 1;
    transform: scale(0.99);
  }

  .rail :global(.auth-card.removing) {
    filter: saturate(0.4);
    opacity: 0;
    pointer-events: none;
    transform: translateX(0.5rem) scale(0.98);
  }

  .rail :global(.auth-card.before) {
    transform: translateX(-0.375rem) scale(0.99);
  }

  .rail :global(.auth-card.after) {
    transform: translateX(0.375rem) scale(0.99);
  }

  .rail :global(.auth-card.active) {
    filter: none;
    opacity: 1;
    transform: translateX(0) scale(1);
  }

  .rail.motion-ready :global(.auth-card.entering) {
    animation: card-enter var(--auth-card-motion-duration) var(--motion-easing-emphasized) both;
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
    color: var(--sable-sec-main);
    cursor: pointer;
    display: flex;
    height: 2.25rem;
    justify-content: center;
    padding: 0;
    pointer-events: auto;
    position: absolute;
    top: 50dvh;
    transform: translateY(-50%);
    transition:
      color var(--motion-normal) var(--motion-easing-standard),
      transform var(--motion-normal) var(--motion-easing-standard);
    width: 2.25rem;
  }

  .panel-nav:focus-visible {
    box-shadow: 0 0 0 0.2rem var(--sable-focus-ring);
    outline: none;
  }

  .panel-nav:hover {
    color: var(--sable-bg-on-container);
    transform: translateY(-50%) scale(1.05);
  }

  .panel-nav :global(svg) {
    height: 1.5rem;
    width: 1.5rem;
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
  }

  @media (width <= 48rem) {
    .rail-shell {
      --auth-card-width: min(24rem, calc(100vw - 5rem));
    }

    .rail {
      scroll-snap-type: x mandatory;
      touch-action: pan-x pan-y;
    }
  }
</style>
