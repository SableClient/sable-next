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
    bottom: var(--space-3);
    display: grid;
    gap: var(--space-2);
    inset-inline: var(--space-3);
    justify-items: center;
    pointer-events: none;
    position: fixed;
    z-index: 100;
  }

  .dock > :global(*) {
    pointer-events: auto;
    width: min(34rem, 100%);
  }
</style>
