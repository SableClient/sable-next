<script lang="ts">
  import type { ClassValue } from 'svelte/elements';
  import type { Snippet } from 'svelte';
  import SettingsAnchorLink from './SettingsAnchorLink.svelte';
  import './settings-row.css';

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
        <h2 id={headingId} data-settings-outline>{title}</h2>
        <SettingsAnchorLink anchor={headingId} />
        {#if titleActions}{@render titleActions()}{/if}
      </div>
      {#if description}<p class="settings-description">{description}</p>{/if}
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
    padding: var(--space-200) var(--space-300) var(--space-100);
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
    background: var(--surface-container);
    border-radius: var(--radius);
    color: var(--surface-on-container);
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
    color: var(--sec-main);
    font-size: var(--font-size-label);
    font-weight: var(--font-weight-medium);
    letter-spacing: 0;
    line-height: var(--line-height-body);
    margin: 0;
    padding: 0;
    text-transform: none;
  }

  .settings-section-actions {
    flex: 0 0 auto;
  }

  @media (width >= 42rem) {
    .settings-section-header {
      align-items: center;
    }
  }
</style>
