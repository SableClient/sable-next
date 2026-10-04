<script lang="ts">
  import ArrowLeftIcon from 'phosphor-svelte/lib/ArrowLeftIcon';
  import GridFourIcon from 'phosphor-svelte/lib/GridFourIcon';
  import PlusIcon from 'phosphor-svelte/lib/PlusIcon';
  import XIcon from 'phosphor-svelte/lib/XIcon';
  import { onMount } from 'svelte';

  import { i18n } from '#lib/i18n.js';
  import ConfirmDialog from '#lib/ui/primitives/ConfirmDialog.svelte';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import PanelHeader from '#lib/ui/primitives/PanelHeader.svelte';
  import PanelHeaderButton from '#lib/ui/primitives/PanelHeaderButton.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import ResizeHandle from '#lib/ui/primitives/ResizeHandle.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';

  import type { RoomWidget } from './widget-content.js';
  import { templateWidgetUrl } from './widget-url.js';
  import IntegrationManagerDialog from './IntegrationManagerDialog.svelte';
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
    onAdd?: (name: string, url: string) => Promise<void>;
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
    onAdd,
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
  let newName = $state('');
  let newUrl = $state('');
  let adding = $state(false);
  let showAddForm = $state(false);
  let integrationsOpen = $state(false);

  let addUrl = $derived.by(() => {
    try {
      const parsed = new URL(newUrl.trim());
      return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.toString() : null;
    } catch {
      return null;
    }
  });

  async function submitAdd(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (!onAdd || adding || addUrl === null || newName.trim() === '') return;
    adding = true;
    try {
      await onAdd(newName.trim(), addUrl);
      newName = '';
      newUrl = '';
      showAddForm = false;
    } finally {
      adding = false;
    }
  }

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

  let activeWidget = $derived(widgets.find((widget) => widget.id === activeId) ?? null);
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
  <PanelHeader class="widgets-header" title={activeWidget?.name || $i18n.t('widgets.title')}>
    {#snippet prefix()}
      {#if activeWidget}
        <PanelHeaderButton label={$i18n.t('widgets.back')} onclick={() => (activeId = null)}>
          <ArrowLeftIcon />
        </PanelHeaderButton>
      {/if}
    {/snippet}
    {#snippet suffix()}
      <PanelHeaderButton label={$i18n.t('widgets.close')} onclick={onClose}>
        <XIcon />
      </PanelHeaderButton>
    {/snippet}
  </PanelHeader>

  {#if activeWidget && activeUrl}
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
  {:else}
    <div class="widgets-list">
      {#if widgets.length === 0}
        <p class="widgets-empty">{$i18n.t('widgets.empty')}</p>
      {/if}
      {#each widgets as widget (widget.id)}
        <div class="widgets-item choice">
          <button type="button" onclick={() => (activeId = widget.id)}>
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
  {/if}

  {#if !activeWidget && canManage && onAdd}
    <div class="widgets-manage">
      {#if showAddForm}
        <form class="widgets-add" onsubmit={submitAdd}>
          <TextInput
            bind:value={newName}
            placeholder={$i18n.t('widgets.addName')}
            aria-label={$i18n.t('widgets.addName')}
          />
          <TextInput
            bind:value={newUrl}
            type="url"
            placeholder={$i18n.t('widgets.addUrl')}
            aria-label={$i18n.t('widgets.addUrl')}
          />
          <Button type="submit" disabled={adding || addUrl === null || newName.trim() === ''}>
            {$i18n.t('widgets.add')}
          </Button>
        </form>
      {:else}
        <Button variant="ghost" onclick={() => (integrationsOpen = true)}>
          <GridFourIcon />
          {$i18n.t('widgets.integrationManager')}
        </Button>
        <Button variant="ghost" onclick={() => (showAddForm = true)}>
          <PlusIcon />
          {$i18n.t('widgets.addCustom')}
        </Button>
      {/if}
    </div>
  {/if}
</aside>

<IntegrationManagerDialog
  open={integrationsOpen}
  {roomId}
  onClose={() => (integrationsOpen = false)}
/>

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
    --ghost-hover: var(--bg-container-hover);
    --ghost-active: var(--bg-container-active);

    background: var(--bg-container);
    box-sizing: border-box;
    color: var(--bg-on-container);
    display: grid;
    grid-template-rows: auto minmax(0, 1fr) auto;
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

  .widgets-manage {
    align-self: start;
    border-top: var(--border-width) solid var(--surface-container-line);
    display: grid;
    gap: var(--space-100);
    padding: var(--space-300);
  }

  .widgets-add {
    display: grid;
    gap: var(--space-200);
  }

  .widgets-empty {
    color: var(--surface-var-on-container);
    padding: var(--space-100);
  }

  .widgets-list {
    display: flex;
    flex-direction: column;
    gap: var(--space-100);
    overflow-y: auto;
    padding: var(--space-300);
  }

  .widgets-item {
    align-items: center;
    background: var(--surface-var-container);
    border: var(--border-width) solid var(--surface-var-container-line);
    border-radius: var(--radius);
    color: var(--surface-var-on-container);
    display: flex;
    gap: var(--space-100);
    padding-inline-end: var(--space-100);
  }

  .widgets-item button:first-child {
    background: none;
    border: none;
    color: inherit;
    cursor: pointer;
    flex: 1;
    font: inherit;
    min-height: 2.75rem;
    overflow: hidden;
    padding: var(--space-100) var(--space-300);
    text-align: start;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .widgets-item :global(.icon-button) {
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
