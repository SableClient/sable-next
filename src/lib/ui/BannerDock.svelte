<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    children: Snippet;
  }

  let { children }: Props = $props();
</script>

<div class="dock">
  {@render children()}
</div>

<style>
  .dock {
    bottom: calc(var(--space-400) + var(--safe-bottom));
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
</style>
