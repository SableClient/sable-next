<script lang="ts">
  import { resolve } from '$app/paths';
  import { Dialog } from 'bits-ui';
  import type { Snippet } from 'svelte';
  import ArrowLeftIcon from 'phosphor-svelte/lib/ArrowLeftIcon';
  import CaretRightIcon from 'phosphor-svelte/lib/CaretRightIcon';
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
  import TextInput from '#lib/ui/primitives/TextInput.svelte';
  import { sectionsAfterCategories, sectionsBeforeCategories } from './sections.js';
  import { defaultSettingsSection } from './settings-navigation';
  import { searchSettings } from './settings-search.js';

  interface Props {
    section: string | null;
    onSelect: (section: string) => void;
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

  function select(event: MouseEvent, nextSection: string): void {
    if (event.shiftKey || event.metaKey || event.ctrlKey || event.button !== 0) return;

    event.preventDefault();
    onSelect(nextSection);
  }
</script>

<div class="settings-shell" class:paged={!desktop}>
  <Dialog.Description class="screen-reader-only">
    {$i18n.t('settings.dialogDescription')}
  </Dialog.Description>

  {#if showList}
    <aside class="settings-nav" aria-label={$i18n.t('settings.title')}>
      <div class="settings-title">
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
        <p class="search-summary" aria-live="polite">
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
            <li>
              <a
                class="sable-selection-layer"
                href={`${resolve(`settings/${hit.category.id}`)}?focus=${settingFocusId(hit.setting.key)}`}
                onclick={(event) => {
                  select(event, hit.category.id);
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
        <nav aria-label={$i18n.t('settings.sections')}>
          {#each sections as entry (entry.id)}
            {@const active = openSection === entry.id}
            <a
              class="sable-selection-layer"
              href={resolve(`settings/${entry.id}`)}
              class:active
              aria-current={active ? 'page' : undefined}
              onclick={(event) => {
                select(event, entry.id);
              }}
            >
              <span class="icon" aria-hidden="true"><entry.icon /></span>
              <span class="label">{$i18n.t(entry.label)}</span>
              <span class="chevron" aria-hidden="true"><CaretRightIcon /></span>
            </a>
          {/each}
        </nav>
      {/if}
      <Button
        block
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
        <div class="settings-title section-bar">
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

  .settings-nav {
    background: var(--sable-surface-container);
    border-right: var(--border-width) solid var(--sable-surface-container-line);
    display: flex;
    flex: 0 0 13.5rem;
    flex-direction: column;
    padding-bottom: var(--space-3);
  }

  .settings-title {
    align-items: center;
    display: flex;
    justify-content: space-between;
    min-height: 4rem;
    padding: var(--space-2) var(--space-3);
  }

  :global(.settings-heading) {
    font-size: var(--font-size-xlarge);
    font-weight: var(--font-weight-bold);
    margin: 0;
    padding: 0;
  }

  nav,
  .search-results {
    display: grid;
    gap: 0;
    list-style: none;
    margin: 0;
    min-height: 0;
    overflow-y: auto;
    padding: 0;
  }

  .settings-search {
    padding: 0 var(--space-3) var(--space-2);
  }

  .search-field {
    align-items: center;
    background: var(--sable-bg-container);
    border: var(--border-width) solid var(--sable-surface-container-line);
    border-radius: var(--radius);
    display: flex;
    gap: var(--space-2);
    min-height: var(--control-height-medium);
    padding: 0 var(--space-2);
  }

  .search-field :global(svg) {
    color: var(--sable-surface-var-on-container);
    flex: 0 0 auto;
    height: var(--icon-size-small);
    width: var(--icon-size-small);
  }

  .search-field :global(.text-input) {
    background: transparent;
    border: 0;
    min-height: var(--control-height-medium);
    padding: 0;
  }

  .search-summary {
    color: var(--sable-surface-var-on-container);
    font-size: var(--font-size-small);
    margin: var(--space-1) 0 0;
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

  a {
    align-items: center;
    border-left: calc(var(--border-width) * 3) solid transparent;
    color: inherit;
    display: flex;
    font-weight: var(--font-weight-medium);
    gap: var(--space-2);
    min-height: var(--control-height-medium);
    padding: 0 var(--space-3);
    text-decoration: none;
  }

  a:hover {
    background: var(--sable-surface-container-hover);
  }

  a.active {
    border-left-color: var(--sable-primary-main);
    color: var(--sable-bg-on-container);
  }

  .icon {
    align-items: center;
    display: flex;
    flex: 0 0 auto;
    justify-content: center;
  }

  a :global(svg) {
    height: var(--icon-size-small);
    width: var(--icon-size-small);
  }

  :global(.settings-logout) {
    justify-content: flex-start;
    margin: auto var(--space-3) 0;
    min-height: var(--control-height-medium);
    width: auto;
  }

  .chevron {
    display: none;
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
    gap: var(--space-1);
    justify-content: flex-start;
  }

  .section-bar :global(.settings-heading) {
    flex: 1;
    font-size: var(--font-size-large);
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .paged .settings-nav {
    border-right: 0;
    flex: 1;
  }

  .paged .settings-title {
    min-height: var(--control-height-large);
  }

  .paged nav,
  .paged .search-results {
    flex: 1;
  }

  .paged a {
    border-left: 0;
    min-height: var(--control-height-large);
  }

  .paged .label {
    flex: 1;
    min-width: 0;
  }

  .paged .chevron {
    color: var(--sable-surface-var-on-container);
    display: flex;
    flex: 0 0 auto;
  }

  .paged a.active {
    background: var(--sable-surface-container-hover);
  }

  @media (width >= 28rem) {
    :global(.settings-logout) {
      min-height: auto;
    }
  }
</style>
