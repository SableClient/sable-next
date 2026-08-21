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

<div {...rest} class={['sable-alert', `sable-alert-${variant}`, className]}>
  {#if title}<strong>{title}</strong>{/if}
  {@render children?.()}
</div>

<style>
  :global(.sable-alert) {
    border: var(--border-width) solid;
    border-radius: var(--radius);
    display: grid;
    gap: var(--space-compact);
    padding: var(--space-2);
  }

  :global(.sable-alert p) {
    margin: 0;
  }

  :global(.sable-alert-info) {
    background: var(--sable-primary-container);
    border-color: var(--sable-primary-container-line);
    color: var(--sable-primary-on-container);
  }

  :global(.sable-alert-success) {
    background: var(--sable-success-container);
    border-color: var(--sable-success-container-line);
    color: var(--sable-success-on-container);
  }

  :global(.sable-alert-warning) {
    background: var(--sable-warn-container);
    border-color: var(--sable-warn-container-line);
    color: var(--sable-warn-on-container);
  }

  :global(.sable-alert-critical) {
    background: var(--sable-crit-container);
    border-color: var(--sable-crit-container-line);
    color: var(--sable-crit-on-container);
  }
</style>
