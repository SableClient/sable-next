<script lang="ts">
  import type { Snippet } from 'svelte';

  interface Props {
    id: string;
    title: string;
    level?: 2 | 3;
    count?: number;
    hidden?: boolean;
    heading?: HTMLElement;
    children?: Snippet;
  }

  let {
    id,
    title,
    level = 2,
    count,
    hidden = false,
    heading = $bindable(),
    children,
  }: Props = $props();
</script>

<div class="header">
  <svelte:element
    this={level === 2 ? 'h2' : 'h3'}
    {id}
    class={['title', { 'screen-reader-only': hidden }]}
    tabindex="-1"
    bind:this={heading}
  >
    {title}
    {#if count !== undefined}
      <span class="count">{count}</span>
    {/if}
  </svelte:element>
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

  .title {
    align-items: center;
    color: var(--surface-var-on-container);
    display: flex;
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-500);
    gap: var(--space-200);
    letter-spacing: 0.08em;
    margin: 0;
    text-transform: uppercase;
  }

  .title:focus {
    outline: none;
  }

  .count {
    background: var(--surface-var-container);
    border-radius: var(--radius-pill);
    color: var(--surface-var-on-container);
    font-variant-numeric: tabular-nums;
    letter-spacing: normal;
    min-width: 1.25rem;
    padding: 0 var(--space-100);
    text-align: center;
  }
</style>
