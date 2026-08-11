<script lang="ts">
  import type { HTMLInputAttributes } from 'svelte/elements';

  type Props = Omit<HTMLInputAttributes, 'value'> & {
    value?: string;
  };

  let { value = $bindable(''), class: className = '', ...rest }: Props = $props();
</script>

<input bind:value {...rest} class={`text-input ${className}`.trim()} />

<style>
  .text-input {
    background: var(--sable-bg-container);
    border: 1px solid var(--sable-bg-container-line);
    border-radius: var(--radius);
    color: var(--sable-bg-on-container);
    font: inherit;
    min-height: 2.75rem;
    padding: 0.625rem var(--input-padding-right, 0.875rem) 0.625rem 0.875rem;

    transition:
      border-color 120ms ease,
      box-shadow 120ms ease;
  }

  .text-input:focus-visible {
    border-color: var(--sable-primary-main);
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--sable-primary-main) 30%, transparent);
    outline: none;
  }
</style>
