<script lang="ts">
  import type { Snippet } from 'svelte';
  import '#lib/ui/primitives/form-control.css';

  interface Props {
    id?: string;
    children: Snippet;
    trailing?: Snippet;
  }

  let { id, children, trailing }: Props = $props();
</script>

<div {id} class="auth-info-box form-control">
  <div class="auth-info-box-content">{@render children()}</div>
  {@render trailing?.()}
</div>

<style>
  .auth-info-box {
    align-items: center;
    display: flex;
    gap: var(--space-100);
    justify-content: space-between;
    width: 100%;
  }

  .auth-info-box-content {
    align-items: center;
    display: flex;
    flex: 1 1 auto;
    gap: var(--space-100);
    min-width: 0;
    overflow-wrap: anywhere;
  }
</style>
