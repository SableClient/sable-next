<script lang="ts">
  import type { ClassValue } from 'svelte/elements';
  import type { Snippet } from 'svelte';

  type Props = {
    title: string;
    description?: string;
    headingId: string;
    class?: ClassValue;
    icon?: Snippet;
    actions?: Snippet;
    children?: Snippet;
  };

  let {
    title,
    description,
    headingId,
    class: className = '',
    icon,
    actions,
    children,
  }: Props = $props();
</script>

<section class={['settings-section', className]} aria-labelledby={headingId}>
  <header class="settings-section-header">
    {#if icon}<span class="settings-section-icon" aria-hidden="true">{@render icon()}</span>{/if}
    <div class="settings-section-heading">
      <h2 id={headingId}>{title}</h2>
      {#if description}<p>{description}</p>{/if}
    </div>
    {#if actions}<div class="settings-section-actions">{@render actions()}</div>{/if}
  </header>
  <div class="settings-section-content">{@render children?.()}</div>
</section>

<style>
  .settings-section {
    background: var(--sable-bg-container);
    border: 1px solid var(--sable-bg-container-line);
    border-radius: var(--radius-card);
    overflow: hidden;
  }

  .settings-section-header {
    align-items: flex-start;
    display: flex;
    gap: var(--space-3);
    justify-content: space-between;
    padding: var(--space-2) var(--space-3);
  }

  .settings-section-heading {
    flex: 1;
    min-width: 0;
  }

  .settings-section-icon {
    align-items: center;
    background: var(--sable-surface-container);
    border-radius: var(--radius);
    color: var(--sable-surface-var-on-container);
    display: flex;
    flex: 0 0 auto;
    height: var(--control-height-medium);
    justify-content: center;
    width: var(--control-height-medium);
  }

  .settings-section-icon :global(svg) {
    height: var(--icon-size-medium);
    width: var(--icon-size-medium);
  }

  h2 {
    font-size: var(--font-size-large);
    line-height: var(--line-height-heading);
    margin: 0;
  }

  p {
    color: var(--sable-surface-var-on-container);
    font-size: var(--font-size-small);
    margin: calc(var(--space-1) / 2) 0 0;
  }

  .settings-section-actions {
    flex: 0 0 auto;
  }

  .settings-section-content {
    border-top: 1px solid var(--sable-bg-container-line);
  }

  @media (width >= 42rem) {
    .settings-section-header {
      align-items: center;
    }
  }
</style>
