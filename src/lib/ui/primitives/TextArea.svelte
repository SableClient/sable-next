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
  {...rest}
  bind:value
  class={['form-control', 'text-area', { 'form-control-error': error }, className]}></textarea>

<style>
  .text-area {
    --form-control-background: var(--sable-surface-container);
    --form-control-border: var(--sable-surface-container-line);
    --form-control-color: var(--sable-surface-on-container);
    --form-control-padding-inline: var(--space-2);
    --form-control-padding-inline-end: var(--space-2);

    min-height: 6rem;
    resize: vertical;
    width: 100%;
  }
</style>
