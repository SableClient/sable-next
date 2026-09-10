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
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-600);
    justify-content: center;
    line-height: var(--line-height-small);
    min-height: 1.25rem;
    min-width: 1.25rem;
    padding: 0 var(--space-200);
  }

  :global(.status-badge-neutral) {
    background: var(--surface-container);
    border-color: var(--surface-container-line);
    color: var(--surface-var-on-container);
  }

  :global(.status-badge-primary) {
    background: var(--primary-container);
    border-color: var(--primary-container-line);
    color: var(--primary-on-container);
  }

  :global(.status-badge-secondary) {
    background: var(--sec-container);
    border-color: var(--sec-container-line);
    color: var(--sec-on-container);
  }

  :global(.status-badge-success) {
    background: var(--success-container);
    border-color: var(--success-container-line);
    color: var(--success-on-container);
  }

  :global(.status-badge-warning) {
    background: var(--warn-container);
    border-color: var(--warn-container-line);
    color: var(--warn-on-container);
  }

  :global(.status-badge-critical) {
    background: var(--crit-container);
    border-color: var(--crit-container-line);
    color: var(--crit-on-container);
  }
</style>
