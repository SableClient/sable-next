<script lang="ts">
  import { Button as BitsButton } from 'bits-ui';
  import type { Snippet } from 'svelte';
  import type { HTMLButtonAttributes } from 'svelte/elements';

  type Props = {
    type?: 'button' | 'submit' | 'reset';
    disabled?: boolean;
    onclick?: HTMLButtonAttributes['onclick'];
    children?: Snippet;
  };

  let { type = 'button', disabled = false, onclick, children }: Props = $props();
</script>

<BitsButton.Root {type} {disabled} {onclick} class="sable-button">
  {@render children?.()}
</BitsButton.Root>

<style>
  :global(.sable-button) {
    align-items: center;
    background: var(--sable-primary-container);
    border: 1px solid var(--sable-primary-container-line);
    border-radius: var(--radius);
    color: var(--sable-primary-on-container);
    display: flex;
    gap: 0.5rem;
    justify-content: center;
    min-height: 2.75rem;
  }

  @media (prefers-reduced-motion: no-preference) {
    :global(.sable-button) {
      transition:
        background-color var(--motion-normal) ease,
        border-color var(--motion-normal) ease,
        box-shadow var(--motion-normal) ease,
        filter var(--motion-normal) ease;
    }
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
