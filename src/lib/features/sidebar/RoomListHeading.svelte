<script lang="ts">
  import type { Snippet } from 'svelte';
  import CategoryCaret from './CategoryCaret.svelte';

  interface Props {
    label: string;
    closed: boolean;
    controls: string;
    onToggle: () => void;
    trailing?: Snippet;
  }

  let { label, closed, controls, onToggle, trailing }: Props = $props();
</script>

<div class="rooms-heading-row">
  <button
    type="button"
    role="treeitem"
    aria-level="1"
    aria-selected="false"
    class="rooms-heading selection-layer"
    aria-expanded={!closed}
    data-state={closed ? 'closed' : 'open'}
    aria-controls={controls}
    onclick={onToggle}
  >
    <span class="rooms-heading-label">{label}</span>
    <CategoryCaret {closed} />
  </button>
  {#if trailing}
    <div class="rooms-heading-trailing">
      {@render trailing()}
    </div>
  {/if}
</div>

<style>
  .rooms-heading-row {
    align-items: center;
    display: flex;
    gap: var(--space-100);
    margin-inline: var(--space-200);
    min-width: 0;
    width: calc(100% - var(--space-200) * 2);
  }

  .rooms-heading {
    align-items: center;
    background: transparent;
    border: 0;
    border-radius: var(--radius);
    color: inherit;
    cursor: pointer;
    display: flex;
    flex: 1 1 auto;
    font: inherit;
    gap: var(--space-100);
    height: var(--control-height-medium);
    min-width: 0;
    opacity: var(--opacity-p300);
    padding: 0 var(--space-200);
    text-align: start;
  }

  .rooms-heading:focus-visible {
    background: var(--bg-container-hover);
    outline: var(--focus-ring-width) solid var(--focus-ring);
    outline-offset: 2px;
  }

  @media (any-hover: hover) and (any-pointer: fine) {
    .rooms-heading:hover {
      background: var(--bg-container-hover);
    }
  }

  .rooms-heading-label {
    font-size: var(--font-size-label);
    font-weight: var(--font-weight-500);
    margin: 0;
  }

  .rooms-heading-trailing {
    align-items: center;
    display: flex;
    flex: none;
  }

  @media (--app-layout) {
    .rooms-heading {
      height: var(--control-height-small);
    }
  }
</style>
