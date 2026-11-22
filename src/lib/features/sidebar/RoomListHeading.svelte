<script lang="ts">
  import CategoryCaret from './CategoryCaret.svelte';

  interface Props {
    label: string;
    closed: boolean;
    controls: string;
    onToggle: () => void;
  }

  let { label, closed, controls, onToggle }: Props = $props();
</script>

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

<style>
  .rooms-heading {
    align-items: center;
    background: transparent;
    border: 0;
    border-radius: var(--radius);
    color: inherit;
    cursor: pointer;
    display: flex;
    font: inherit;
    gap: var(--space-100);
    height: var(--control-height-medium);
    margin-inline: var(--space-200);
    opacity: var(--opacity-p300);
    padding: 0 var(--space-200);
    text-align: start;
    width: calc(100% - var(--space-200) * 2);
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

  @media (--app-layout) {
    .rooms-heading {
      height: var(--control-height-small);
    }
  }
</style>
