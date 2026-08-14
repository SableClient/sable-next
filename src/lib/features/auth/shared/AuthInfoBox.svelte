<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    id?: string;
    children: Snippet;
    trailing?: Snippet;
  }

  let { id, children, trailing }: Props = $props();
</script>

<div {id} class="auth-info-box">
  <div class="auth-info-box-content">{@render children()}</div>
  {@render trailing?.()}
</div>

<style>
  .auth-info-box {
    align-items: center;
    background: var(--sable-bg-container);
    border: 1px solid var(--sable-bg-container-line);
    border-radius: var(--radius);
    box-sizing: border-box;
    color: var(--sable-bg-on-container);
    display: flex;
    gap: var(--space-1);
    min-height: var(--control-height-medium);
    padding: var(--control-padding-block) var(--control-padding-inline);
  }

  .auth-info-box-content {
    align-items: center;
    display: flex;
    flex: 1 1 auto;
    gap: var(--space-1);
    min-width: 0;
    overflow-wrap: anywhere;
  }
</style>
