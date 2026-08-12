<script lang="ts">
  import type { ClassValue } from 'svelte/elements';

  type StatusBadgeVariant = 'neutral' | 'primary' | 'success' | 'warning' | 'critical';

  type Props = {
    label: string;
    variant?: StatusBadgeVariant;
    class?: ClassValue;
  };

  let { label, variant = 'neutral', class: className = '' }: Props = $props();
</script>

<span class={['status-badge', `status-badge-${variant}`, className]}>{label}</span>

<style>
  :global(.status-badge) {
    border: 1px solid transparent;
    border-radius: var(--radius-pill);
    display: inline-flex;
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-medium);
    line-height: 1.25;
    padding: 0.2rem 0.55rem;
  }

  :global(.status-badge-neutral) {
    background: var(--sable-surface-container);
    border-color: var(--sable-surface-container-line);
    color: var(--sable-surface-var-on-container);
  }

  :global(.status-badge-primary) {
    background: var(--sable-primary-container);
    border-color: var(--sable-primary-container-line);
    color: var(--sable-primary-on-container);
  }

  :global(.status-badge-success) {
    background: var(--sable-success-container);
    border-color: var(--sable-success-container-line);
    color: var(--sable-success-on-container);
  }

  :global(.status-badge-warning) {
    background: var(--sable-warn-container);
    border-color: var(--sable-warn-container-line);
    color: var(--sable-warn-on-container);
  }

  :global(.status-badge-critical) {
    background: var(--sable-crit-container);
    border-color: var(--sable-crit-container-line);
    color: var(--sable-crit-on-container);
  }
</style>
