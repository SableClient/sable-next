<script lang="ts">
  import type { ClassValue, HTMLInputAttributes } from 'svelte/elements';

  type Props = Omit<HTMLInputAttributes, 'value' | 'class'> & {
    value?: string;
    class?: ClassValue;
  };

  let { value = $bindable(''), class: className = '', ...rest }: Props = $props();
</script>

<input bind:value {...rest} class={['text-input', className]} />

<style>
  .text-input {
    background: var(--sable-bg-container);
    border: 1px solid var(--sable-bg-container-line);
    border-radius: var(--radius);
    color: var(--sable-bg-on-container);
    min-height: 2.75rem;
    padding: 0.625rem var(--input-padding-right, 0.875rem) 0.625rem 0.875rem;
  }

  @media (prefers-reduced-motion: no-preference) {
    .text-input {
      transition:
        border-color var(--motion-normal) ease,
        box-shadow var(--motion-normal) ease;
    }
  }

  .text-input:focus-visible {
    border-color: var(--sable-primary-main);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--sable-primary-main) 30%, transparent);
    outline: none;
  }

  .text-input:autofill,
  .text-input:-webkit-autofill {
    border-color: var(--sable-primary-container-line);
    -webkit-text-fill-color: var(--sable-bg-on-container);
  }

  .text-input:-webkit-autofill {
    box-shadow: 0 0 0 1000px var(--sable-bg-container) inset;
  }

  .text-input[aria-invalid='true'] {
    border-color: var(--sable-crit-main);
  }

  .text-input[aria-invalid='true']:focus-visible {
    border-color: var(--sable-crit-main);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--sable-crit-main) 30%, transparent);
  }
</style>
