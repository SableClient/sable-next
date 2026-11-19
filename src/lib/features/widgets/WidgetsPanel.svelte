<script lang="ts">
  import { clamp } from '#lib/clamp.js';
  import { panelIn, panelOut, usePanelStage } from '#lib/ui/motion.js';
  import ArrowLeftIcon from 'phosphor-svelte/lib/ArrowLeftIcon';
  import ShieldSlashIcon from 'phosphor-svelte/lib/ShieldSlashIcon';
  import XIcon from 'phosphor-svelte/lib/XIcon';

  import { i18n } from '#lib/i18n.js';
  import { readText, removeLocalValue, writeText } from '#lib/platform/local-json.js';
  import PanelHeader from '#lib/ui/primitives/PanelHeader.svelte';
  import PanelHeaderButton from '#lib/ui/primitives/PanelHeaderButton.svelte';
  import ResizeHandle from '#lib/ui/primitives/ResizeHandle.svelte';

  import type { RoomWidget } from './widget-content.js';
  import { widgetPermissionKey } from './capabilities.js';
  import { templateWidgetUrl } from './widget-url.js';
  import WidgetList from './WidgetList.svelte';
  import WidgetView from './WidgetView.svelte';

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
  const stage = usePanelStage();

  const WIDTH_STORAGE_KEY = 'sable-widgets-panel-width';
  const MIN_WIDTH = 18;
  const MAX_WIDTH = 48;
  const WIDTH_STEP = 1;

  const storedWidth = Number.parseFloat(readText(WIDTH_STORAGE_KEY) ?? '');
  let width = $state(Number.isFinite(storedWidth) ? clampWidth(storedWidth) : 22);
  let activeId = $state<string | null>(null);

  function clampWidth(next: number): number {
    return clamp(next, MIN_WIDTH, MAX_WIDTH);
  }

  function remFromPixels(pixels: number): number {
    return pixels / Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
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
  let activeKey = $derived(
    activeWidget && activeUrl ? widgetPermissionKey(userId, roomId, activeWidget, activeUrl) : null
  );
</script>

{#snippet widgetBack()}
  <PanelHeaderButton label={i18n.t('widgets.back')} onclick={() => (activeId = null)}>
    <ArrowLeftIcon class="mirror-rtl" />
  </PanelHeaderButton>
{/snippet}

<aside
  in:panelIn|global={{ modal, stage }}
  out:panelOut|global={{ modal, stage }}
  class={['widgets-panel', { modal }]}
  aria-label={i18n.t('widgets.label')}
  data-focus-region="panel"
  style:width={modal ? null : `${width}rem`}
>
  {#if !modal}
    <ResizeHandle
      value={width}
      min={MIN_WIDTH}
      max={MAX_WIDTH}
      label={i18n.t('widgets.resize')}
      grow="left"
      step={WIDTH_STEP}
      fromPixels={remFromPixels}
      onResize={(next) => (width = clampWidth(next))}
      onCommit={() => writeText(WIDTH_STORAGE_KEY, String(width))}
    />
  {/if}
  <PanelHeader
    class="widgets-header"
    title={activeWidget?.name || i18n.t('widgets.title')}
    prefix={activeWidget ? widgetBack : undefined}
  >
    {#snippet suffix()}
      {#if activeKey}
        {@const key = activeKey}
        <PanelHeaderButton
          label={i18n.t('widgets.capabilitiesForget')}
          onclick={() => {
            removeLocalValue(key);
            activeId = null;
          }}
        >
          <ShieldSlashIcon />
        </PanelHeaderButton>
      {/if}
      <PanelHeaderButton label={i18n.t('widgets.close')} onclick={onClose}>
        <XIcon />
      </PanelHeaderButton>
    {/snippet}
  </PanelHeader>

  {#if activeWidget && activeUrl && activeKey}
    {#key activeKey}
      <WidgetView {roomId} widget={activeWidget} url={activeUrl} permissionKey={activeKey} />
    {/key}
  {:else}
    <WidgetList
      {roomId}
      {widgets}
      {canManage}
      onOpen={(id) => (activeId = id)}
      {onAdd}
      {onRemove}
    />
  {/if}
</aside>

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
    border-inline-start: var(--border-width) solid var(--surface-container-line);
    flex: 0 0 auto;
  }

  .widgets-panel :global(.resize-handle) {
    inset-inline-start: -0.25rem;
    z-index: 1;
  }
</style>
