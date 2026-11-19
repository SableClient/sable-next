<script lang="ts">
  import type { Snippet } from 'svelte';

  import { scrollHint } from '#lib/ui/scroll-hint.js';

  interface Props {
    padded?: boolean;
    toolbar?: Snippet;
    children: Snippet;
  }

  let { padded = false, toolbar, children }: Props = $props();
</script>

{#if toolbar}
  <div class="panel-toolbar">{@render toolbar()}</div>
{/if}
<div class={['panel-body', { padded }]} {@attach scrollHint}>
  {@render children()}
</div>

<style>
  .panel-toolbar {
    display: grid;
    flex: none;
    gap: var(--space-200);
    padding: var(--space-300) var(--space-300) var(--space-200);
  }

  .panel-body {
    flex: 1 1 auto;
    min-height: 0;
    overflow-y: auto;
    overscroll-behavior: contain;
  }

  .panel-body.padded {
    padding: var(--space-300);
  }
</style>
