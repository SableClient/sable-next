<script lang="ts">
  import XIcon from 'phosphor-svelte/lib/XIcon';

  import { i18n } from '#lib/i18n.js';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';

  import type { RoomWidget } from './widget-content.js';
  import { templateWidgetUrl } from './widget-url.js';

  interface Props {
    roomId: string;
    widgets: readonly RoomWidget[];
    userId: string;
    displayName: string;
    avatarUrl: string;
    canManage?: boolean;
    modal?: boolean;
    onClose: () => void;
    onRemove?: (widgetId: string) => void;
  }

  let {
    roomId,
    widgets,
    userId,
    displayName,
    avatarUrl,
    canManage = false,
    modal = false,
    onClose,
    onRemove,
  }: Props = $props();

  let activeId = $state<string | null>(null);

  let activeWidget = $derived(
    widgets.find((widget) => widget.id === activeId) ?? widgets[0] ?? null
  );
  let activeUrl = $derived(
    activeWidget
      ? templateWidgetUrl(activeWidget.url, {
          roomId,
          userId,
          displayName,
          avatarUrl,
          widgetId: activeWidget.id,
        })
      : null
  );
</script>

<aside class="widgets-panel" class:modal aria-label={$i18n.t('widgets.label')}>
  <header class="widgets-header">
    <h2>{$i18n.t('widgets.title')}</h2>
    <IconButton variant="ghost" size="small" label={$i18n.t('widgets.close')} onclick={onClose}>
      <XIcon />
    </IconButton>
  </header>

  {#if widgets.length === 0}
    <p class="widgets-empty">{$i18n.t('widgets.empty')}</p>
  {:else}
    <div class="widgets-tabs" role="tablist">
      {#each widgets as widget (widget.id)}
        <div class="widgets-tab" class:active={widget.id === activeWidget?.id}>
          <button
            type="button"
            role="tab"
            aria-selected={widget.id === activeWidget?.id}
            onclick={() => (activeId = widget.id)}
          >
            {widget.name}
          </button>
          {#if canManage}
            <IconButton
              variant="ghost"
              size="small"
              label={$i18n.t('widgets.remove', { name: widget.name })}
              onclick={() => onRemove?.(widget.id)}
            >
              <XIcon />
            </IconButton>
          {/if}
        </div>
      {/each}
    </div>

    {#if activeUrl && activeWidget}
      {#key activeWidget.id}
        <iframe
          class="widgets-frame"
          title={activeWidget.name}
          src={activeUrl}
          sandbox="allow-scripts allow-forms allow-popups"
          allow="camera; microphone; autoplay; clipboard-write; display-capture; fullscreen; encrypted-media"
        ></iframe>
      {/key}
    {/if}
  {/if}
</aside>

<style>
  .widgets-panel {
    background: var(--sable-surface-container);
    box-sizing: border-box;
    display: grid;
    grid-template-rows: auto auto minmax(0, 1fr);
    height: 100%;
    min-height: 0;
    overflow-x: hidden;
    width: 100%;
  }

  @media (width >= 48rem) {
    .widgets-panel:not(.modal) {
      border-left: var(--border-width) solid var(--sable-surface-container-line);
      width: 22rem;
    }
  }

  .widgets-header {
    align-items: center;
    border-bottom: var(--border-width) solid var(--sable-surface-container-line);
    display: flex;
    gap: var(--space-2);
    justify-content: space-between;
    padding: var(--space-2) var(--space-3);
  }

  .widgets-header h2 {
    font-size: var(--font-size-large);
    font-weight: var(--font-weight-bold);
    margin: 0;
  }

  .widgets-header :global(.sable-icon-button) {
    min-height: 2.75rem;
    min-width: 2.75rem;
  }

  .widgets-empty {
    color: var(--sable-surface-var-on-container);
    padding: var(--space-3);
  }

  .widgets-tabs {
    display: flex;
    flex-wrap: nowrap;
    gap: var(--space-100);
    overflow-x: auto;
    padding: var(--space-2);
  }

  .widgets-tab {
    align-items: center;
    background: var(--sable-surface-var-container);
    border: var(--border-width) solid var(--sable-surface-var-container-line);
    border-radius: var(--radius-pill);
    display: flex;
    flex-shrink: 0;
    gap: var(--space-100);
    padding-inline-end: var(--space-100);
  }

  .widgets-tab.active {
    background: var(--sable-primary-container);
    border-color: var(--sable-primary-container-line);
    color: var(--sable-primary-on-container);
  }

  .widgets-tab button {
    background: none;
    border: none;
    color: inherit;
    cursor: pointer;
    font: inherit;
    font-size: var(--font-size-small);
    min-height: 2.75rem;
    padding: var(--space-100) var(--space-2);
  }

  .widgets-tab :global(.sable-icon-button) {
    min-height: 2.75rem;
    min-width: 2.75rem;
  }

  .widgets-frame {
    border: none;
    box-sizing: border-box;
    display: block;
    height: 100%;
    max-width: 100%;
    width: 100%;
  }
</style>
