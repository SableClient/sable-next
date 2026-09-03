<script lang="ts">
  import type { Snippet } from 'svelte';
  import { Dialog } from 'bits-ui';
  import ArrowLeftIcon from 'phosphor-svelte/lib/ArrowLeftIcon';
  import XIcon from 'phosphor-svelte/lib/XIcon';

  import { i18n } from '#lib/i18n.js';
  import { BREAKPOINTS } from '#lib/ui/breakpoints.js';
  import { createMediaQuery } from '#lib/ui/media-query.svelte.js';
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
  const appLayout = createMediaQuery(BREAKPOINTS.appLayout);

  let desktop = $derived(appLayout.matches);
  let openSection = $derived(section ?? (desktop ? (sections[0]?.id ?? null) : null));
  let showList = $derived(desktop || section === null);
  let showContent = $derived(desktop || section !== null);
  let activeLabel = $derived(
    sections.find((entry) => entry.id === openSection)?.label ?? 'room.settingsTitle'
  );
</script>

<div class="room-settings" class:paged={!desktop}>
  <Dialog.Description class="screen-reader-only">
    {$i18n.t('room.settingsDialogDescription')}
  </Dialog.Description>

  {#if showList}
    <div class="settings-nav sable-settings-nav" class:sable-settings-nav-paged={!desktop}>
      <div class="nav-header sable-settings-nav-header">
        {@render header()}
        {#if !desktop}
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
        activeId={openSection}
        ariaLabel={$i18n.t('room.settingsSections')}
        onSelect={(_, id) => onSelect(id as RoomSettingsSectionId)}
        showChevron={!desktop}
        large={!desktop}
      />
    </div>
  {/if}

  {#if showContent && openSection}
    <div class="settings-page">
      <div class="page-header sable-settings-nav-header">
        {#if !desktop}
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
        <div class="page-body">{@render content(openSection)}</div>
      </div>
    </div>
  {/if}
</div>

<style>
  .room-settings {
    background: var(--sable-bg-container);
    color: var(--sable-bg-on-container);
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
    gap: var(--space-300);
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
