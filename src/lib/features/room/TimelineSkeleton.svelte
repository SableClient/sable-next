<script lang="ts">
  import { i18n } from '#lib/i18n.js';
  import Skeleton from '#lib/ui/primitives/Skeleton.svelte';
  import { prefersReducedMotion } from 'svelte/motion';
  import { innerHeight } from 'svelte/reactivity/window';
  import { fade } from 'svelte/transition';
  import type { TransitionConfig } from 'svelte/transition';

  /* Held rather than delayed: a fast open would flash the rows for a few
     milliseconds instead, which reads as a fade. */
  const MIN_VISIBLE = 400;
  const FADE_OUT = 200;
  const ROW_HEIGHT = 40;
  const shownAt = Date.now();
  const WIDTHS = [62, 44, 71, 38, 55, 48, 66, 40, 58, 33];
  const GROUPED = [false, true, true, false, true, false, false, true, true, false];

  /* Counted off the window, not measured: the box is never taller, and a
     measurement lands a frame late. The surplus clips off the top. */
  let rows = $derived(
    Array.from({ length: Math.ceil((innerHeight.current ?? 0) / ROW_HEIGHT) + 1 }, (_, index) => ({
      id: index,
      collapsed: GROUPED[index % GROUPED.length] ?? false,
      width: `${String(WIDTHS[index % WIDTHS.length] ?? 50)}%`,
    }))
  );

  function holdThenFade(node: Element): TransitionConfig {
    return fade(node, {
      delay: Math.max(0, MIN_VISIBLE - (Date.now() - shownAt)),
      duration: prefersReducedMotion.current ? 0 : FADE_OUT,
    });
  }
</script>

<!-- Opaque, above the settled viewport: fading out uncovers the messages. -->
<div
  class="timeline-skeleton"
  aria-label={$i18n.t('timeline.loading')}
  role="status"
  out:holdThenFade
>
  {#each rows as row (row.id)}
    <div
      class={['timeline-skeleton-row', { collapsed: row.collapsed }]}
      style:--skeleton-body-width={row.width}
      aria-hidden="true"
    >
      {#if !row.collapsed}<Skeleton class="timeline-skeleton-avatar" />{/if}
      <div class="timeline-skeleton-copy">
        {#if !row.collapsed}
          <div class="timeline-skeleton-header">
            <Skeleton class="timeline-skeleton-sender" />
            <Skeleton class="timeline-skeleton-time" />
          </div>
        {/if}
        <Skeleton class="timeline-skeleton-body" />
      </div>
    </div>
  {/each}
</div>

<style>
  .timeline-skeleton {
    background: var(--sable-bg-container);
    display: flex;
    flex-direction: column;
    inset: 0;
    justify-content: flex-end;
    overflow: hidden;
    padding: 0 var(--page-gutter) 1rem;
    pointer-events: none;
    position: absolute;
    z-index: 1;
  }

  .timeline-skeleton-row {
    display: flex;
    flex: 0 0 auto;
    gap: var(--timeline-row-gap);
    padding: var(--timeline-row-padding) 0;
  }

  .timeline-skeleton-row.collapsed {
    padding-left: calc(var(--avatar-size-small) + var(--timeline-row-gap));
  }

  .timeline-skeleton-copy {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 0.375rem;
    justify-content: center;
    min-width: 0;
  }

  .timeline-skeleton-header {
    align-items: center;
    display: flex;
    gap: 0.5rem;
    height: 1rem;
  }

  :global(.sable-skeleton.timeline-skeleton-avatar) {
    border-radius: var(--radius-pill);
    flex: 0 0 var(--avatar-size-small);
    height: var(--avatar-size-small);
    width: var(--avatar-size-small);
  }

  :global(.sable-skeleton.timeline-skeleton-sender) {
    height: 0.625rem;
    width: 6.5rem;
  }

  :global(.sable-skeleton.timeline-skeleton-time) {
    height: 0.5rem;
    width: 3rem;
  }

  :global(.sable-skeleton.timeline-skeleton-body) {
    height: 0.75rem;
    max-width: 28rem;
    width: var(--skeleton-body-width);
  }
</style>
