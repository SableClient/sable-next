<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    children?: Snippet;
  }

  let { children }: Props = $props();
</script>

<div class="form-actions">
  {@render children?.()}
</div>

<style>
  .form-actions {
    display: grid;
    gap: var(--space-300);
  }
</style>
