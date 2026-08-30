<script lang="ts">
  import type { ClassValue } from 'svelte/elements';
  import type { Snippet } from 'svelte';

  type Props = {
    title: string;
    description?: string;
    headingId: string;
    class?: ClassValue;
    icon?: Snippet;
    titleActions?: Snippet;
    actions?: Snippet;
    children?: Snippet;
  };

  let {
    title,
    description,
    headingId,
    class: className = '',
    icon,
    titleActions,
    actions,
    children,
  }: Props = $props();
</script>

<section class={['settings-section', className]} aria-labelledby={headingId}>
  <header class="settings-section-header">
    {#if icon}<span class="settings-section-icon" aria-hidden="true">{@render icon()}</span>{/if}
    <div class="settings-section-heading">
      <div class="settings-section-title">
        <h2 id={headingId}>{title}</h2>
        {#if titleActions}{@render titleActions()}{/if}
      </div>
      {#if description}<p>{description}</p>{/if}
    </div>
    {#if actions}<div class="settings-section-actions">{@render actions()}</div>{/if}
  </header>
  <div class="settings-section-content">{@render children?.()}</div>
</section>

<style>
  .settings-section-header {
    align-items: flex-start;
    display: flex;
    gap: var(--space-400);
    justify-content: space-between;
    padding: var(--space-300) var(--space-400);
  }

  .settings-section-heading {
    flex: 1;
    min-width: 0;
  }

  .settings-section-title {
    align-items: center;
    display: flex;
    gap: var(--space-200);
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
    font-size: var(--font-size-heading);
    line-height: var(--line-height-heading);
    margin: 0;
  }

  p {
    color: var(--sable-surface-var-on-container);
    font-size: var(--font-size-small);
    margin: var(--space-100) 0 0;
  }

  .settings-section-actions {
    flex: 0 0 auto;
  }

  .settings-section-content {
    background: var(--sable-surface-var-container);
    border-radius: var(--radius);
  }

  @media (width >= 42rem) {
    .settings-section-header {
      align-items: center;
    }
  }
</style>
