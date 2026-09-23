<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    id: string;
    title: string;
    hidden?: boolean;
    heading?: HTMLElement;
    children?: Snippet;
  }

  let { id, title, hidden = false, heading = $bindable(), children }: Props = $props();
</script>

<div class="header">
  <h2 {id} class={{ 'screen-reader-only': hidden }} tabindex="-1" bind:this={heading}>{title}</h2>
  {@render children?.()}
</div>

<style>
  .header {
    align-items: baseline;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-200) var(--space-400);
    justify-content: space-between;
    margin-bottom: var(--space-300);
  }

  h2 {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-500);
    letter-spacing: 0.08em;
    margin: 0;
    text-transform: uppercase;
  }

  h2:focus {
    outline: none;
  }
</style>
