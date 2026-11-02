<script lang="ts">
  import TrayIcon from 'phosphor-svelte/lib/TrayIcon';
  import ChatsIcon from 'phosphor-svelte/lib/ChatsIcon';
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
  }

  let { panels, voiceView, direct, desktop, widgetCount, canManageWidgets }: Props = $props();
</script>

{#if !voiceView}
  <PanelHeaderButton
    label={i18n.t('timeline.threadsOpen')}
    aria-pressed={panels.threadsOpen}
    onclick={() => panels.toggleThreads()}
  >
    <ChatsIcon weight={panels.threadsOpen ? 'fill' : 'regular'} />
  </PanelHeaderButton>
  {#if !direct}
    <PanelHeaderButton
      label={i18n.t('room.notificationsOpen')}
      aria-pressed={panels.notificationsOpen}
      onclick={() => panels.toggleNotifications()}
    >
      <TrayIcon weight={panels.notificationsOpen ? 'fill' : 'regular'} />
    </PanelHeaderButton>
  {/if}
  {#if desktop}
    <PanelHeaderButton
      label={i18n.t('timeline.attachmentsTitle')}
      aria-pressed={panels.attachmentsOpen}
      onclick={() => panels.toggleAttachments()}
    >
      <ImagesIcon weight={panels.attachmentsOpen ? 'fill' : 'regular'} />
    </PanelHeaderButton>
  {/if}
{/if}
{#if widgetCount > 0 || canManageWidgets}
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
  .widgets-count {
    background: var(--surface-container-active);
    border-radius: var(--radius-pill);
    color: var(--surface-on-container);
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-bold);
    left: 0;
    line-height: 1;
    min-width: 1rem;
    padding: var(--space-050) var(--space-100);
    position: absolute;
    text-align: center;
    top: 0;
  }
</style>
