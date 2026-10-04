<script lang="ts">
  import CrownSimpleIcon from 'phosphor-svelte/lib/CrownSimpleIcon';
  import type { ClassValue } from 'svelte/elements';

  type Props = {
    label: string;
    title?: string;
    class?: ClassValue;
  };

  let { label, title, class: className = '' }: Props = $props();
</script>

<span class={['supporter-badge', className]} {title}>
  <CrownSimpleIcon aria-hidden="true" weight="fill" />
  {label}
</span>

<style>
  .supporter-badge {
    align-items: center;
    background: var(--primary-container);
    border: var(--border-width) solid var(--primary-container-line);
    border-radius: var(--radii-300);
    color: var(--primary-on-container);
    display: inline-flex;
    flex-shrink: 0;
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-600);
    gap: var(--space-100);
    line-height: var(--line-height-small);
    max-width: 100%;
    min-height: 1.25rem;
    padding: 0 var(--space-200);
  }
</style>
