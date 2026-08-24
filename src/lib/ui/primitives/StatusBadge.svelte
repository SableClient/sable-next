<script lang="ts">
  import type { ClassValue } from 'svelte/elements';

  type StatusBadgeVariant =
    | 'neutral'
    | 'secondary'
    | 'primary'
    | 'success'
    | 'warning'
    | 'critical';

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
    align-items: center;
    border: var(--border-width) solid transparent;
    border-radius: var(--radii-300);
    display: inline-flex;
    flex-shrink: 0;
    font-size: var(--font-size-l400);
    font-weight: var(--font-weight-600);
    justify-content: center;
    line-height: var(--line-height-l400);
    min-height: 1.25rem;
    min-width: 1.25rem;
    padding: 0 var(--space-200);
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

  :global(.status-badge-secondary) {
    background: var(--sable-sec-container);
    border-color: var(--sable-sec-container-line);
    color: var(--sable-sec-on-container);
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
