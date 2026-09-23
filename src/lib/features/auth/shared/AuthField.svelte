<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    labelId: string;
    label: string;
    children: Snippet;
  }

  let { labelId, label, children }: Props = $props();
</script>

<div class="auth-field">
  <h2 id={labelId}>{label}</h2>
  {@render children()}
</div>

<style>
  .auth-field {
    display: grid;
    gap: var(--space-100);
  }

  .auth-field h2 {
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-medium);
    line-height: var(--line-height-heading);
    margin: 0;
  }
</style>
