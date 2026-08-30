<script lang="ts">
  import type { Snippet } from 'svelte';
  import { Dialog } from 'bits-ui';
  import ArrowLeftIcon from 'phosphor-svelte/lib/ArrowLeftIcon';
  import XIcon from 'phosphor-svelte/lib/XIcon';

  import { i18n } from '#lib/i18n.js';
  import { BREAKPOINTS } from '#lib/ui/breakpoints.js';
  import { createMediaQuery } from '#lib/ui/media-query.svelte.js';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';

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
    <div class="settings-nav">
      <div class="nav-header">
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
      <nav aria-label={$i18n.t('room.settingsSections')}>
        {#each sections as entry (entry.id)}
          {@const active = openSection === entry.id}
          <button
            type="button"
            class:active
            aria-pressed={active}
            onclick={() => {
              onSelect(entry.id);
            }}
          >
            <span class="icon" aria-hidden="true"
              ><entry.icon weight={active ? 'fill' : 'regular'} /></span
            >
            <span class="label">{$i18n.t(entry.label)}</span>
          </button>
        {/each}
      </nav>
    </div>
  {/if}

  {#if showContent && openSection}
    <div class="settings-page">
      <div class="page-header">
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

  .settings-nav {
    background: var(--sable-surface-container);
    border-right: var(--border-width) solid var(--sable-surface-container-line);
    display: flex;
    flex: 0 0 13.5rem;
    flex-direction: column;
    min-height: 0;
  }

  .nav-header {
    align-items: center;
    border-bottom: var(--border-width) solid var(--sable-surface-container-line);
    display: flex;
    flex: 0 0 auto;
    gap: var(--space-300);
    justify-content: space-between;
    min-height: var(--control-height-large);
    padding: 0 var(--space-200) 0 var(--space-300);
  }

  nav {
    align-content: start;
    display: grid;
    flex: 1;
    gap: var(--space-050);
    min-height: 0;
    overflow-y: auto;
    padding: var(--space-200);
  }

  nav button {
    align-items: center;
    background: transparent;
    border: 0;
    border-radius: var(--radius);
    color: inherit;
    cursor: pointer;
    display: flex;
    font: inherit;
    font-size: var(--font-size-small);
    gap: var(--space-300);
    line-height: var(--line-height-small);
    min-height: var(--control-height-medium);
    padding: 0 var(--space-300);
    text-align: left;
    width: 100%;
  }

  nav button:hover {
    background: var(--sable-surface-container-hover);
  }

  nav button:focus-visible {
    outline: var(--focus-ring-width) solid var(--sable-focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  nav button.active {
    background: var(--sable-surface-container-active);
    font-weight: var(--font-weight-medium);
  }

  .icon {
    align-items: center;
    display: flex;
    flex: 0 0 auto;
    justify-content: center;
  }

  nav button :global(svg) {
    height: var(--icon-size-small);
    width: var(--icon-size-small);
  }

  .settings-page {
    display: flex;
    flex: 1;
    flex-direction: column;
    min-height: 0;
    min-width: 0;
  }

  .page-header {
    align-items: center;
    background: var(--sable-surface-container);
    border-bottom: var(--border-width) solid var(--sable-surface-container-line);
    display: flex;
    flex: 0 0 auto;
    gap: var(--space-200);
    min-height: var(--control-height-large);
    padding: 0 var(--space-200) 0 var(--space-400);
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

  .paged .settings-nav {
    border-right: 0;
    flex: 1;
  }
</style>
