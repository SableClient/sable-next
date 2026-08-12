<script lang="ts">
  import CaretDownIcon from 'phosphor-icons-svelte/IconCaretDownRegular.svelte';

  interface Props {
    expanded: boolean;
    showLabel: string;
    hideLabel: string;
    onToggle: () => void;
  }

  let { expanded, showLabel, hideLabel, onToggle }: Props = $props();
</script>

<button class="method-toggle" type="button" aria-expanded={expanded} onclick={onToggle}>
  <span>{expanded ? hideLabel : showLabel}</span>
  <span class:expanded class="method-toggle-icon" aria-hidden="true"><CaretDownIcon /></span>
</button>

<style>
  .method-toggle {
    align-items: center;
    background: transparent;
    border: 0;
    color: var(--sable-sec-main);
    cursor: pointer;
    display: flex;
    font-size: var(--font-size-small);
    gap: 0.5rem;
    justify-content: center;
    padding: 0.25rem;
  }

  .method-toggle:hover {
    color: var(--sable-bg-on-container);
  }

  .method-toggle-icon {
    align-items: center;
    display: flex;
    transition: transform var(--motion-normal) ease;
  }

  .method-toggle-icon.expanded {
    transform: rotate(180deg);
  }

  .method-toggle-icon :global(svg) {
    height: 1rem;
    width: 1rem;
  }

  @media (prefers-reduced-motion: reduce) {
    .method-toggle-icon {
      transition: none;
    }
  }
</style>
