<script lang="ts">
  import type { ClassValue, HTMLInputAttributes } from 'svelte/elements';
  import './form-control.css';

  type Props = Omit<HTMLInputAttributes, 'value' | 'class'> & {
    value?: string;
    class?: ClassValue;
  };

  let { value = $bindable(''), class: className = '', ...rest }: Props = $props();
</script>

<input bind:value {...rest} class={['form-control', 'text-input', className]} />

<style>
  .text-input {
    width: 100%;
  }

  .text-input:autofill,
  .text-input:-webkit-autofill {
    -webkit-text-fill-color: var(--sable-bg-on-container);
  }

  .text-input:-webkit-autofill {
    box-shadow: 0 0 0 1000px var(--sable-bg-container) inset;
  }
</style>
