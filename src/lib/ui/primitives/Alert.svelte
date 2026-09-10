<script lang="ts">
  import type { ClassValue, HTMLAttributes } from 'svelte/elements';
  import type { Snippet } from 'svelte';

  export type AlertVariant = 'info' | 'success' | 'warning' | 'critical';

  type Props = Omit<HTMLAttributes<HTMLDivElement>, 'class' | 'children'> & {
    variant?: AlertVariant;
    title?: string;
    class?: ClassValue;
    children?: Snippet;
  };

  let { variant = 'info', title, class: className = '', children, ...rest }: Props = $props();
</script>

<div {...rest} class={['alert', `alert-${variant}`, className]}>
  {#if title}<strong>{title}</strong>{/if}
  {@render children?.()}
</div>

<style>
  :global(.alert) {
    border: var(--border-width) solid;
    border-radius: var(--radius);
    display: grid;
    gap: var(--space-100);
    padding: var(--space-300);
  }

  :global(.alert p) {
    margin: 0;
  }

  :global(.alert-info) {
    background: var(--primary-container);
    border-color: var(--primary-container-line);
    color: var(--primary-on-container);
  }

  :global(.alert-success) {
    background: var(--success-container);
    border-color: var(--success-container-line);
    color: var(--success-on-container);
  }

  :global(.alert-warning) {
    background: var(--warn-container);
    border-color: var(--warn-container-line);
    color: var(--warn-on-container);
  }

  :global(.alert-critical) {
    background: var(--crit-container);
    border-color: var(--crit-container-line);
    color: var(--crit-on-container);
  }
</style>
