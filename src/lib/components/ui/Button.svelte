<script lang="ts">
  import { Button as BitsButton } from 'bits-ui';
  import type { Snippet } from 'svelte';

  type Props = {
    type?: 'button' | 'submit' | 'reset';
    disabled?: boolean;
    children?: Snippet;
  };

  let { type = 'button', disabled = false, children }: Props = $props();
</script>

<BitsButton.Root {type} {disabled} class="sable-button">
  {@render children?.()}
</BitsButton.Root>

<style>
  :global(.sable-button) {
    background: var(--sable-primary-container);
    border: 1px solid var(--sable-primary-container-line);
    border-radius: var(--radius);
    color: var(--sable-primary-on-container);
    font: inherit;
    min-height: 2.75rem;

    transition:
      background-color 150ms ease,
      border-color 150ms ease,
      box-shadow 120ms ease,
      filter 120ms ease;
  }

  :global(.sable-button:hover:not(:disabled)) {
    background: var(--sable-primary-container-hover);
  }

  :global(.sable-button:active:not(:disabled)) {
    background: var(--sable-primary-container-hover);
    box-shadow: inset 0 1px 3px rgb(0 0 0 / 12%);
    filter: brightness(0.96);
  }

  :global(.sable-button:disabled) {
    opacity: 0.65;
  }
</style>
