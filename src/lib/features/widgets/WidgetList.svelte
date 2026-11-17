<script lang="ts">
  import PlusIcon from 'phosphor-svelte/lib/PlusIcon';
  import GridFourIcon from 'phosphor-svelte/lib/GridFourIcon';
  import XIcon from 'phosphor-svelte/lib/XIcon';

  import { i18n } from '#lib/i18n.js';
  import ConfirmDialog from '#lib/ui/primitives/ConfirmDialog.svelte';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';
  import { scrollHint } from '#lib/ui/scroll-hint.js';

  import type { RoomWidget } from './widget-content.js';
  import IntegrationManagerDialog from './IntegrationManagerDialog.svelte';

  interface Props {
    roomId: string;
    widgets: readonly RoomWidget[];
    canManage?: boolean;
    onOpen: (widgetId: string) => void;
    onAdd?: (name: string, url: string) => Promise<void>;
    onRemove?: (widgetId: string) => void;
  }

  let { roomId, widgets, canManage = false, onOpen, onAdd, onRemove }: Props = $props();

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
</script>

<div class="widgets-list" {@attach scrollHint}>
  {#if widgets.length === 0}
    <p class="widgets-empty">{i18n.t('widgets.empty')}</p>
  {/if}
  {#each widgets as widget (widget.id)}
    <div class="widgets-item choice">
      <button type="button" onclick={() => onOpen(widget.id)}>
        {widget.name}
      </button>
      {#if canManage}
        <IconButton
          variant="ghost"
          size="small"
          label={i18n.t('widgets.remove', { name: widget.name })}
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

{#if canManage && onAdd}
  <div class="widgets-manage">
    {#if showAddForm}
      <form class="widgets-add" onsubmit={submitAdd}>
        <TextInput
          bind:value={newName}
          placeholder={i18n.t('widgets.addName')}
          aria-label={i18n.t('widgets.addName')}
        />
        <TextInput
          bind:value={newUrl}
          type="url"
          placeholder={i18n.t('widgets.addUrl')}
          aria-label={i18n.t('widgets.addUrl')}
        />
        <Button type="submit" disabled={adding || addUrl === null || newName.trim() === ''}>
          {i18n.t('widgets.add')}
        </Button>
      </form>
    {:else}
      <Button variant="ghost" onclick={() => (integrationsOpen = true)}>
        <GridFourIcon />
        {i18n.t('widgets.integrationManager')}
      </Button>
      <Button variant="ghost" onclick={() => (showAddForm = true)}>
        <PlusIcon />
        {i18n.t('widgets.addCustom')}
      </Button>
    {/if}
  </div>
{/if}

<IntegrationManagerDialog
  open={integrationsOpen}
  {roomId}
  onClose={() => (integrationsOpen = false)}
/>

<ConfirmDialog
  open={pendingRemoval !== null}
  onOpenChange={(next: boolean) => {
    if (!next) pendingRemoval = null;
  }}
  title={i18n.t('widgets.removeConfirm', { name: pendingRemoval?.name ?? '' })}
  description={i18n.t('widgets.removeHint')}
  confirmLabel={i18n.t('widgets.remove', { name: pendingRemoval?.name ?? '' })}
  onConfirm={() => {
    onRemove?.(pendingRemoval?.id ?? '');
    pendingRemoval = null;
  }}
/>

<style>
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
    gap: var(--space-150);
    overflow-y: auto;
    padding: var(--space-300);
  }

  .widgets-item {
    align-items: center;
    background: var(--surface-container);
    border-radius: var(--radius-inner);
    color: var(--surface-on-container);
    display: flex;
    gap: var(--space-150);
    padding-inline-end: var(--space-300);
  }

  .widgets-item:hover {
    background: var(--surface-container-hover);
    box-shadow: inset 0 0 0 var(--border-width) var(--surface-container-line);
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
</style>
