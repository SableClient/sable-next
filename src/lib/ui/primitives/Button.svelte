<script lang="ts">
  import { Button as BitsButton } from 'bits-ui';
  import type { Snippet } from 'svelte';
  import type { HTMLButtonAttributes } from 'svelte/elements';

  type Props = {
    type?: 'button' | 'submit' | 'reset';
    variant?: 'soft' | 'primary';
    disabled?: boolean;
    onclick?: HTMLButtonAttributes['onclick'];
    class?: string;
    children?: Snippet;
  };

  let {
    type = 'button',
    variant = 'soft',
    disabled = false,
    onclick,
    class: className = '',
    children,
  }: Props = $props();
</script>

<BitsButton.Root
  {type}
  {disabled}
  {onclick}
  class={`sable-button ${variant === 'primary' ? 'primary' : ''} ${className}`}
>
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

  :global(.sable-button.primary) {
    background: var(--sable-primary-main);
    border-color: var(--sable-primary-main-line);
    color: var(--sable-primary-on-main);
  }

  :global(.sable-button.primary:hover:not(:disabled)) {
    background: var(--sable-primary-main-hover);
  }

  :global(.sable-button:active:not(:disabled)) {
    background: var(--sable-primary-container-hover);
    box-shadow: inset 0 1px 3px rgb(0 0 0 / 12%);
    filter: brightness(0.96);
  }

  :global(.sable-button.primary:active:not(:disabled)) {
    background: var(--sable-primary-main-active);
  }

  :global(.sable-button:disabled) {
    opacity: 0.65;
  }
</style>
