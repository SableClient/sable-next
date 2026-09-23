<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    children: Snippet;
  }

  let { children }: Props = $props();
</script>

<div class="dialog-actions">
  {@render children()}
</div>

<style>
  .dialog-actions {
    display: flex;
    gap: var(--space-200);
    justify-content: flex-end;
  }
</style>
