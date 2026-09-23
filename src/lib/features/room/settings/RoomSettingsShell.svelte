<script lang="ts">
  import type { Snippet } from 'svelte';
  import { Dialog } from 'bits-ui';
  import ArrowLeftIcon from 'phosphor-svelte/lib/ArrowLeftIcon';
  import XIcon from 'phosphor-svelte/lib/XIcon';

  import { i18n } from '#lib/i18n.js';
  import { createMasterDetail } from '#lib/ui/master-detail.svelte.js';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import SettingsNav from '#lib/ui/primitives/SettingsNav.svelte';

  import type { RoomSettingsSection, RoomSettingsSectionId } from './room-settings-sections';

  interface Props {
    section: RoomSettingsSectionId | null;
    sections: readonly RoomSettingsSection[];
    onSelect: (section: RoomSettingsSectionId) => void;
    onBack: () => void;
    onClose: () => void;
    header: Snippet;
    content: Snippet<[RoomSettingsSectionId]>;
  }

  let { section, sections, onSelect, onBack, onClose, header, content }: Props = $props();
  const pages = createMasterDetail(
    () => section,
    () => sections[0]?.id ?? null
  );
  let activeLabel = $derived(
    sections.find((entry) => entry.id === pages.openSection)?.label ?? 'room.settingsTitle'
  );
</script>

<div class="room-settings" class:paged={!pages.desktop}>
  <Dialog.Description class="screen-reader-only">
    {$i18n.t('room.settingsDialogDescription')}
  </Dialog.Description>

  {#if pages.showList}
    <div class="settings-nav" class:settings-nav-paged={!pages.desktop}>
      <div class="nav-header settings-nav-header">
        {@render header()}
        {#if !pages.desktop}
          <IconButton
            variant="ghost"
            size="small"
            label={$i18n.t('room.settingsClose')}
            onclick={onClose}><XIcon /></IconButton
          >
        {/if}
      </div>
      <SettingsNav
        entries={sections.map((entry) => ({ ...entry, label: $i18n.t(entry.label) }))}
        activeId={pages.openSection}
        ariaLabel={$i18n.t('room.settingsSections')}
        onSelect={(_, id) => onSelect(id as RoomSettingsSectionId)}
        showChevron={!pages.desktop}
        large={!pages.desktop}
      />
    </div>
  {/if}

  {#if pages.showContent && pages.openSection}
    <div class="settings-page">
      <div class="page-header settings-nav-header">
        {#if !pages.desktop}
          <IconButton
            variant="ghost"
            size="small"
            label={$i18n.t('room.settingsBack')}
            onclick={onBack}><ArrowLeftIcon /></IconButton
          >
        {/if}
        <Dialog.Title class="page-title">{$i18n.t(activeLabel)}</Dialog.Title>
        <IconButton
          variant="ghost"
          size="small"
          label={$i18n.t('room.settingsClose')}
          onclick={onClose}><XIcon /></IconButton
        >
      </div>
      <div class="page-scroll">
        <div class="page-body">{@render content(pages.openSection)}</div>
      </div>
    </div>
  {/if}
</div>

<style>
  .room-settings {
    background: var(--bg-container);
    color: var(--bg-on-container);
    display: flex;
    height: 100%;
    min-height: 0;
    width: 100%;
  }

  .settings-page {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
  }

  .page-header {
    flex: 0 0 auto;
  }

  :global(.page-title) {
    flex: 1;
    font-size: var(--font-size-heading);
    font-weight: var(--font-weight-bold);
    line-height: var(--line-height-heading);
    margin: 0;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .page-scroll {
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }

  .page-body {
    display: grid;
    gap: var(--space-600);
    margin-inline: auto;
    max-width: 56rem;
    padding: var(--space-400);
    width: 100%;
  }

  @media (width >= 42rem) {
    .page-body {
      padding: var(--space-500);
    }
  }
</style>
