<script lang="ts">
  import type { Snippet } from 'svelte';

  import { bannerSuppression } from './banner-suppression.svelte.js';
  import { composerClearance } from './composer-clearance.svelte.js';

  interface Props {
    children: Snippet;
  }

  let { children }: Props = $props();
</script>

<div
  class="dock"
  class:suppressed={bannerSuppression.count > 0}
  style:--composer-clearance={`${String(composerClearance.px)}px`}
>
  {@render children()}
</div>

<style>
  .dock {
    bottom: max(
      calc(var(--space-400) + var(--safe-bottom)),
      calc(var(--composer-clearance) + var(--space-200))
    );
    display: grid;
    gap: var(--space-300);
    inset-inline: calc(var(--space-400) + var(--safe-left))
      calc(var(--space-400) + var(--safe-right));
    justify-items: center;
    pointer-events: none;
    position: fixed;
    z-index: var(--layer-notify);
  }

  .dock > :global(*) {
    width: min(34rem, 100%);
  }

  .dock.suppressed {
    visibility: hidden;
  }
</style>
