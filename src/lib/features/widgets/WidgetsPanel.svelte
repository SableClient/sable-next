<script lang="ts">
  import XIcon from 'phosphor-svelte/lib/XIcon';
  import { onMount } from 'svelte';

  import { i18n } from '#lib/i18n.js';
  import ConfirmDialog from '#lib/ui/primitives/ConfirmDialog.svelte';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import ResizeHandle from '#lib/ui/primitives/ResizeHandle.svelte';

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

  const WIDTH_STORAGE_KEY = 'sable-widgets-panel-width';
  const MIN_WIDTH = 18;
  const MAX_WIDTH = 48;
  const WIDTH_STEP = 1;

  let width = $state(22);
  let activeId = $state<string | null>(null);

  function clampWidth(next: number): number {
    return Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, next));
  }

  function remFromPixels(pixels: number): number {
    return pixels / Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
  }

  onMount(() => {
    const stored = Number.parseFloat(localStorage.getItem(WIDTH_STORAGE_KEY) ?? '');
    if (Number.isFinite(stored)) width = clampWidth(stored);
  });
  let pendingRemoval = $state<RoomWidget | null>(null);

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

<aside
  class={['widgets-panel', { modal }]}
  aria-label={$i18n.t('widgets.label')}
  style:width={modal ? null : `${width}rem`}
>
  {#if !modal}
    <ResizeHandle
      value={width}
      min={MIN_WIDTH}
      max={MAX_WIDTH}
      label={$i18n.t('widgets.resize')}
      grow="left"
      step={WIDTH_STEP}
      fromPixels={remFromPixels}
      onResize={(next) => (width = clampWidth(next))}
      onCommit={() => localStorage.setItem(WIDTH_STORAGE_KEY, String(width))}
    />
  {/if}
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
          class="widgets-tab choice"
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
              onclick={() => {
                pendingRemoval = widget;
              }}
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

<ConfirmDialog
  open={pendingRemoval !== null}
  onOpenChange={(next: boolean) => {
    if (!next) pendingRemoval = null;
  }}
  title={$i18n.t('widgets.removeConfirm', { name: pendingRemoval?.name ?? '' })}
  description={$i18n.t('widgets.removeHint')}
  confirmLabel={$i18n.t('widgets.remove', { name: pendingRemoval?.name ?? '' })}
  onConfirm={() => {
    onRemove?.(pendingRemoval?.id ?? '');
    pendingRemoval = null;
  }}
/>

<style>
  .widgets-panel {
    background: var(--surface-container);
    box-sizing: border-box;
    display: grid;
    grid-template-rows: auto auto minmax(0, 1fr);
    height: 100%;
    min-height: 0;
    overflow-x: hidden;
    position: relative;
    width: 100%;
  }

  .widgets-panel:not(.modal) {
    border-left: var(--border-width) solid var(--surface-container-line);
    flex: 0 0 auto;
  }

  .widgets-panel :global(.resize-handle) {
    left: -0.25rem;
    z-index: 1;
  }

  .widgets-header {
    align-items: center;
    border-bottom: var(--border-width) solid var(--surface-container-line);
    display: flex;
    gap: var(--space-300);
    justify-content: space-between;
    min-height: var(--header-height);
    padding: 0 var(--space-400);
  }

  .widgets-header h2 {
    font-size: var(--font-size-heading);
    font-weight: var(--font-weight-bold);
    margin: 0;
  }

  .widgets-header :global(.icon-button) {
    min-height: 2.75rem;
    min-width: 2.75rem;
  }

  .widgets-empty {
    color: var(--surface-var-on-container);
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
    background: var(--surface-var-container);
    border: var(--border-width) solid var(--surface-var-container-line);
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

  .widgets-tab :global(.icon-button) {
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
