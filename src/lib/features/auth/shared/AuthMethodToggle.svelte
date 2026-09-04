<script lang="ts">
  import CaretDownIcon from 'phosphor-svelte/lib/CaretDownIcon';
  import Button from '#lib/ui/primitives/Button.svelte';

  interface Props {
    expanded: boolean;
    controls: string;
    showLabel: string;
    hideLabel: string;
    disabled?: boolean;
    onToggle: () => void;
  }

  let { expanded, controls, showLabel, hideLabel, disabled = false, onToggle }: Props = $props();
</script>

<Button
  variant="ghost"
  size="small"
  class="method-toggle"
  aria-expanded={expanded}
  aria-controls={controls}
  {disabled}
  onclick={onToggle}
>
  <span>{expanded ? hideLabel : showLabel}</span>
  <span class:expanded class="method-toggle-icon" aria-hidden="true"><CaretDownIcon /></span>
</Button>

<style>
  :global(.method-toggle) {
    align-items: center;
    background: transparent;
    border-color: transparent;
    color: var(--sable-sec-main);
    font-size: var(--font-size-small);
    gap: var(--space-200);
    justify-content: center;
    padding: var(--space-100);
  }

  :global(.method-toggle:hover:not(:disabled)) {
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
    height: var(--icon-size-small);
    width: var(--icon-size-small);
  }

  @media (prefers-reduced-motion: reduce) {
    .method-toggle-icon {
      transition: none;
    }
  }
</style>
