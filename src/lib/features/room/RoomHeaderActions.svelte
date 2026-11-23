<script lang="ts">
  import TrayIcon from 'phosphor-svelte/lib/TrayIcon';
  import YarnIcon from 'phosphor-svelte/lib/YarnIcon';
  import ImagesIcon from 'phosphor-svelte/lib/ImagesIcon';
  import GridFourIcon from 'phosphor-svelte/lib/GridFourIcon';
  import { i18n } from '#lib/i18n.js';
  import PanelHeaderButton from '#lib/ui/primitives/PanelHeaderButton.svelte';
  import type { RoomPanels } from './room-panels.svelte.js';

  interface Props {
    panels: RoomPanels;
    voiceView: boolean;
    direct: boolean;
    desktop: boolean;
    widgetCount: number;
    canManageWidgets: boolean;
    threadsUnread?: number;
    threadsOnly?: boolean;
  }

  let {
    panels,
    voiceView,
    direct,
    desktop,
    widgetCount,
    canManageWidgets,
    threadsUnread = 0,
    threadsOnly = false,
  }: Props = $props();
</script>

{#if !voiceView}
  <PanelHeaderButton
    label={threadsUnread > 0
      ? i18n.t('timeline.threadsUnread', { count: threadsUnread })
      : i18n.t('timeline.threadsOpen')}
    aria-pressed={panels.threadsOpen}
    onclick={() => panels.toggleThreads()}
  >
    <YarnIcon weight={panels.threadsOpen ? 'fill' : 'regular'} />
    {#if threadsUnread > 0}
      <span class="threads-count" aria-hidden="true"
        >{threadsUnread > 99 ? '99+' : threadsUnread}</span
      >
    {/if}
  </PanelHeaderButton>
  {#if !threadsOnly && !direct}
    <PanelHeaderButton
      label={i18n.t('room.notificationsOpen')}
      aria-pressed={panels.notificationsOpen}
      onclick={() => panels.toggleNotifications()}
    >
      <TrayIcon weight={panels.notificationsOpen ? 'fill' : 'regular'} />
    </PanelHeaderButton>
  {/if}
  {#if !threadsOnly && desktop}
    <PanelHeaderButton
      label={i18n.t('timeline.attachmentsTitle')}
      aria-pressed={panels.attachmentsOpen}
      onclick={() => panels.toggleAttachments()}
    >
      <ImagesIcon weight={panels.attachmentsOpen ? 'fill' : 'regular'} />
    </PanelHeaderButton>
  {/if}
{/if}
{#if !threadsOnly && (widgetCount > 0 || canManageWidgets)}
  <PanelHeaderButton
    label={i18n.t('widgets.label')}
    aria-pressed={panels.widgetsOpen}
    onclick={() => panels.toggleWidgets()}
  >
    <GridFourIcon weight={panels.widgetsOpen ? 'fill' : 'regular'} />
    {#if widgetCount > 0}
      <span class="widgets-count" aria-hidden="true">{widgetCount}</span>
    {/if}
  </PanelHeaderButton>
{/if}

<style>
  .threads-count,
  .widgets-count {
    background: var(--surface-container-active);
    border-radius: var(--radius-pill);
    color: var(--surface-on-container);
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-bold);
    inset-inline-start: 0;
    line-height: 1;
    min-width: 1rem;
    padding: var(--space-050) var(--space-100);
    position: absolute;
    text-align: center;
    top: 0;
  }

  .threads-count {
    background: var(--primary-main);
    color: var(--primary-on-main);
  }
</style>
