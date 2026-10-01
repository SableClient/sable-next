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
    -webkit-text-fill-color: var(--form-control-color);
  }

  .text-input:-webkit-autofill {
    box-shadow:
      inset 0 0 0 var(--form-control-ring) var(--form-control-line),
      inset 0 0 0 1000px var(--form-control-container);
  }
</style>
