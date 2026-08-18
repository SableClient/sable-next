<script lang="ts">
  import type { HTMLTextareaAttributes } from 'svelte/elements';
  import './form-control.css';

  type Props = Omit<HTMLTextareaAttributes, 'class' | 'value'> & {
    value?: string;
    error?: boolean;
    class?: string;
  };

  let { value = $bindable(''), error = false, class: className = '', ...rest }: Props = $props();
</script>

<textarea
  bind:value
  {...rest}
  class={['form-control', 'text-area', { 'form-control-error': error }, className]}></textarea>

<style>
  .text-area {
    --form-control-padding-inline: var(--space-2);
    --form-control-padding-inline-end: var(--space-2);

    min-height: 6rem;
    resize: vertical;
    width: 100%;
  }
</style>
