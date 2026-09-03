<script lang="ts">
  import XIcon from 'phosphor-svelte/lib/XIcon';

  import { i18n } from '#lib/i18n.js';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';

  import type { RoomWidget } from './widget-content.js';
  import { templateWidgetUrl } from './widget-url.js';
  import WidgetCapabilitiesDialog from './WidgetCapabilitiesDialog.svelte';
  import WidgetFrame from './WidgetFrame.svelte';

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

  interface PendingApproval {
    widgetName: string;
    requested: string[];
    settle: (approved: string[]) => void;
  }

  let approval = $state.raw<PendingApproval | null>(null);

  function requestCapabilities(widgetName: string) {
    return async (requested: Set<string>): Promise<Set<string>> => {
      if (requested.size === 0) return new Set();

      const approved = await new Promise<string[]>((settle) => {
        approval = { widgetName, requested: [...requested], settle };
      });
      approval = null;
      return new Set(approved);
    };
  }

  let activeWidget = $derived(
    widgets.find((widget) => widget.id === activeId) ?? widgets[0] ?? null
  );
  let activeUrl = $derived(
    activeWidget
      ? templateWidgetUrl(activeWidget, {
          roomId,
          userId,
          displayName,
          avatarUrl,
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
        <div
          class="widgets-tab sable-choice"
          data-selected={widget.id === activeWidget?.id ? 'true' : undefined}
        >
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
      {#key activeUrl}
        <div class="widgets-frame">
          <WidgetFrame
            {roomId}
            widgetId={activeWidget.id}
            url={activeUrl}
            name={activeWidget.name}
            onCapabilities={requestCapabilities(activeWidget.name)}
          />
        </div>
      {/key}
    {/if}
  {/if}
</aside>

{#if approval}
  {@const pending = approval}
  <WidgetCapabilitiesDialog
    open
    widgetName={pending.widgetName}
    requested={pending.requested}
    onDecide={pending.settle}
  />
{/if}

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
    gap: var(--space-300);
    justify-content: space-between;
    padding: var(--space-300) var(--space-400);
  }

  .widgets-header h2 {
    font-size: var(--font-size-heading);
    font-weight: var(--font-weight-bold);
    margin: 0;
  }

  .widgets-header :global(.sable-icon-button) {
    min-height: 2.75rem;
    min-width: 2.75rem;
  }

  .widgets-empty {
    color: var(--sable-surface-var-on-container);
    padding: var(--space-400);
  }

  .widgets-tabs {
    display: flex;
    flex-wrap: nowrap;
    gap: var(--space-100);
    overflow-x: auto;
    padding: var(--space-300);
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

  .widgets-tab button {
    background: none;
    border: none;
    color: inherit;
    cursor: pointer;
    font: inherit;
    font-size: var(--font-size-small);
    min-height: 2.75rem;
    padding: var(--space-100) var(--space-300);
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
