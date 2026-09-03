<script lang="ts">
  import { resolve } from '$app/paths';
  import { Dialog } from 'bits-ui';
  import type { Snippet } from 'svelte';
  import ArrowLeftIcon from 'phosphor-svelte/lib/ArrowLeftIcon';
  import MagnifyingGlassIcon from 'phosphor-svelte/lib/MagnifyingGlassIcon';
  import SignOutIcon from 'phosphor-svelte/lib/SignOutIcon';
  import XIcon from 'phosphor-svelte/lib/XIcon';

  import { useCoreClient } from '#lib/core/context.js';
  import { pushOverride } from '#lib/features/notifications/push-config.js';
  import { logoutWithPush } from '#lib/features/notifications/web-push.js';
  import { i18n } from '#lib/i18n.js';
  import { settingFocusId, settingsCategories } from '#lib/settings/registry.js';
  import { BREAKPOINTS } from '#lib/ui/breakpoints.js';
  import { createMediaQuery } from '#lib/ui/media-query.svelte.js';
  import Button from '#lib/ui/primitives/Button.svelte';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import SettingsNav from '#lib/ui/primitives/SettingsNav.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';
  import { sectionsAfterCategories, sectionsBeforeCategories } from './sections.js';
  import { defaultSettingsSection } from './settings-navigation';
  import { searchSettings } from './settings-search.js';

  interface Props {
    section: string | null;
    onSelect: (section: string, focus?: string) => void;
    onBack: () => void;
    onClose: () => void;
    content: Snippet<[string]>;
  }

  let { section, onSelect, onBack, onClose, content }: Props = $props();
  const core = useCoreClient();
  const appLayout = createMediaQuery(BREAKPOINTS.appLayout);
  const sections = [
    ...sectionsBeforeCategories,
    ...settingsCategories.map((category) => ({
      id: category.id,
      label: category.name,
      icon: category.icon,
    })),
    ...sectionsAfterCategories,
  ];
  let desktop = $derived(appLayout.matches);
  let openSection = $derived(section ?? (desktop ? defaultSettingsSection() : null));
  let showList = $derived(desktop || section === null);
  let showContent = $derived(desktop || section !== null);
  let activeLabel = $derived(
    sections.find((entry) => entry.id === openSection)?.label ?? 'settings.title'
  );

  let query = $state('');
  let trimmedQuery = $derived(query.trim());
  let results = $derived(
    trimmedQuery ? searchSettings(trimmedQuery, settingsCategories, $i18n.t) : []
  );

  function select(event: MouseEvent, nextSection: string, focus?: string): void {
    if (event.shiftKey || event.metaKey || event.ctrlKey || event.button !== 0) return;

    event.preventDefault();
    onSelect(nextSection, focus);
  }
</script>

<div class="settings-shell" class:paged={!desktop}>
  <Dialog.Description class="screen-reader-only">
    {$i18n.t('settings.dialogDescription')}
  </Dialog.Description>

  {#if showList}
    <aside
      class="settings-nav sable-settings-nav"
      class:sable-settings-nav-paged={!desktop}
      aria-label={$i18n.t('settings.title')}
    >
      <div class="settings-title sable-settings-nav-header">
        <Dialog.Title class="settings-heading">{$i18n.t('settings.title')}</Dialog.Title>
        <IconButton variant="ghost" size="small" label={$i18n.t('settings.close')} onclick={onClose}
          ><XIcon /></IconButton
        >
      </div>
      <div class="settings-search">
        <label class="screen-reader-only" for="settings-search-input">
          {$i18n.t('settings.searchLabel')}
        </label>
        <div class="search-field">
          <MagnifyingGlassIcon aria-hidden="true" />
          <TextInput
            id="settings-search-input"
            type="search"
            bind:value={query}
            placeholder={$i18n.t('settings.searchPlaceholder')}
            autocomplete="off"
          />
        </div>
        <p class="search-summary" class:active={trimmedQuery !== ''} aria-live="polite">
          {#if trimmedQuery}
            {results.length > 0
              ? $i18n.t('settings.searchResultsCount', { count: results.length })
              : $i18n.t('settings.searchNoResults', { query: trimmedQuery })}
          {/if}
        </p>
      </div>

      {#if trimmedQuery}
        <ul class="search-results" role="list" aria-label={$i18n.t('settings.searchLabel')}>
          {#each results as hit (`${hit.category.id}:${hit.setting.key}`)}
            {@const focus = settingFocusId(hit.setting.key)}
            <li>
              <a
                class="sable-selection-layer"
                href={`${resolve(`settings/${hit.category.id}`)}?focus=${encodeURIComponent(focus)}`}
                onclick={(event) => {
                  select(event, hit.category.id, focus);
                }}
              >
                <span class="icon" aria-hidden="true"><hit.setting.icon /></span>
                <span class="label">
                  <span class="result-name">{$i18n.t(hit.setting.name)}</span>
                  <span class="result-category">
                    {$i18n.t('settings.searchResultCategory', {
                      category: $i18n.t(hit.category.name),
                    })}
                  </span>
                </span>
              </a>
            </li>
          {/each}
        </ul>
      {:else}
        <SettingsNav
          entries={sections.map((entry) => ({ ...entry, label: $i18n.t(entry.label) }))}
          activeId={openSection}
          ariaLabel={$i18n.t('settings.sections')}
          onSelect={select}
          href={(entry) => resolve(`settings/${entry.id}`)}
          showChevron={!desktop}
          large={!desktop}
        />
      {/if}
      <Button
        class="settings-logout"
        variant="danger"
        onclick={() => void logoutWithPush(core, pushOverride())}
      >
        <SignOutIcon />
        <span class="logout-label">{$i18n.t('settings.logout')}</span>
      </Button>
    </aside>
  {/if}

  {#if showContent && openSection}
    <div class="settings-content">
      {#if !desktop}
        <div class="settings-title section-bar sable-settings-nav-header">
          <IconButton variant="ghost" size="small" label={$i18n.t('settings.back')} onclick={onBack}
            ><ArrowLeftIcon /></IconButton
          >
          <Dialog.Title class="settings-heading">{$i18n.t(activeLabel)}</Dialog.Title>
          <IconButton
            variant="ghost"
            size="small"
            label={$i18n.t('settings.close')}
            onclick={onClose}><XIcon /></IconButton
          >
        </div>
      {/if}
      <div class="settings-scroll">{@render content(openSection)}</div>
    </div>
  {/if}
</div>

<style>
  .settings-shell {
    display: flex;
    height: 100%;
    width: 100%;
  }

  :global(.settings-heading) {
    font-size: var(--font-size-heading);
    font-weight: var(--font-weight-bold);
    margin: 0;
    padding: 0;
  }

  .search-results {
    align-content: start;
    display: grid;
    flex: 1;
    gap: 0;
    list-style: none;
    margin: 0;
    min-height: 0;
    min-width: 0;
    overflow: hidden auto;
    padding: var(--space-200);
    scrollbar-gutter: stable;
  }

  .search-results li {
    min-width: 0;
  }

  .search-results .label {
    flex: 1;
    min-width: 0;
  }

  .settings-search {
    padding: 0 var(--space-400) var(--space-300);
  }

  .search-field {
    align-items: center;
    background: var(--sable-bg-container);
    border: var(--border-width) solid var(--sable-surface-container-line);
    border-radius: var(--radius);
    display: flex;
    gap: var(--space-300);
    min-height: var(--control-height-medium);
    padding: 0 var(--space-300);
  }

  .search-field :global(svg) {
    color: var(--sable-surface-var-on-container);
    flex: 0 0 auto;
    height: var(--icon-size-small);
    width: var(--icon-size-small);
  }

  .search-field:focus-within {
    border-color: var(--sable-primary-main);
    box-shadow: inset 0 0 0 var(--border-width-600) var(--sable-primary-main);
  }

  .search-field :global(.text-input) {
    background: transparent;
    box-shadow: none;
    min-height: var(--control-height-medium);
    padding: 0;
  }

  .search-summary {
    font-size: var(--font-size-small);
    margin: 0;
    min-height: 0;
  }

  .search-summary.active {
    color: var(--sable-surface-var-on-container);
    margin: var(--space-200) 0 0;
    min-height: 1lh;
  }

  .result-name,
  .result-category {
    display: block;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .result-category {
    color: var(--sable-surface-var-on-container);
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-normal);
  }

  .search-results .icon {
    align-items: center;
    display: flex;
    flex: 0 0 auto;
    justify-content: center;
  }

  .search-results a {
    align-items: center;
    border-left: calc(var(--border-width) * 3) solid transparent;
    color: inherit;
    display: flex;
    font-weight: var(--font-weight-medium);
    gap: var(--space-300);
    min-height: var(--control-height-medium);
    padding: 0 var(--space-300);
    text-decoration: none;
  }

  .search-results a:hover {
    background: var(--sable-surface-container-hover);
  }

  .search-results a :global(svg) {
    height: var(--icon-size-small);
    width: var(--icon-size-small);
  }

  :global(.settings-logout) {
    flex: 0 0 auto;
    justify-content: flex-start;
    margin: auto var(--space-400) 0;
    min-height: var(--control-height-medium);
    width: auto;
  }

  .settings-content {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-width: 0;
    width: 100%;
  }

  .settings-scroll {
    flex: 1;
    min-height: 0;
    overflow: auto;
  }

  .section-bar {
    background: var(--sable-surface-container);
    border-bottom: var(--border-width) solid var(--sable-surface-container-line);
    flex: 0 0 auto;
    gap: var(--space-300);
    justify-content: flex-start;
  }

  .section-bar :global(.settings-heading) {
    flex: 1;
    font-size: var(--font-size-heading);
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .paged .search-results a {
    border-left: 0;
    min-height: var(--control-height-large);
  }

  .paged :global(.settings-logout) {
    min-height: var(--control-height-large);
  }
</style>
