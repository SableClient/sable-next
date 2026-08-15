<script lang="ts">
  import type { ClassValue, HTMLSelectAttributes } from 'svelte/elements';
  import type { Snippet } from 'svelte';
  import './form-control.css';

  type Props = Omit<HTMLSelectAttributes, 'value' | 'class'> & {
    value?: string;
    class?: ClassValue;
    children: Snippet;
  };

  let { value = $bindable(''), class: className = '', children, ...rest }: Props = $props();
</script>

<select bind:value {...rest} class={['form-control', 'select', className]}>
  {@render children()}
</select>

<style>
  .select {
    cursor: pointer;
    width: 100%;
  }
</style>
