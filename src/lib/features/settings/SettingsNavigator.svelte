<script lang="ts">
  import { resolve } from '$app/paths';
  import type { Snippet } from 'svelte';
  import MagnifyingGlassIcon from 'phosphor-svelte/lib/MagnifyingGlassIcon';
  import SignOutIcon from 'phosphor-svelte/lib/SignOutIcon';

  import { useCoreClient } from '#lib/core/context.js';
  import { pushOverride } from '#lib/features/notifications/push-config.js';
  import { logoutWithPush } from '#lib/features/notifications/web-push.js';
  import SignOutWarningDialog from '#lib/features/sidebar/SignOutWarningDialog.svelte';
  import { SignOutGuard } from '#lib/features/sidebar/sign-out-guard.svelte.js';
  import { i18n } from '#lib/i18n.js';
  import {
    canonicalSection,
    findCategory,
    settingFocusId,
    settingsCategories,
  } from '#lib/settings/registry.js';
  import SettingsNav from '#lib/ui/primitives/SettingsNav.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';
  import SettingsShell, { type SettingsShellNav } from './SettingsShell.svelte';
  import { findStandaloneSection, settingsNavGroups } from './sections.js';
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
  const signOut = new SignOutGuard(core);
  const groups = settingsNavGroups.map((group) => ({
    id: group.id,
    label: group.label,
    entries: group.sections.flatMap((id) => {
      const entry = findStandaloneSection(id) ?? findCategory(id);
      if (!entry) return [];
      return [{ id, label: 'label' in entry ? entry.label : entry.name, icon: entry.icon }];
    }),
  }));
  const sections = groups.flatMap((group) => group.entries);

  let query = $state('');
  let trimmedQuery = $derived(query.trim());
  let results = $derived(
    trimmedQuery ? searchSettings(trimmedQuery, settingsCategories, $i18n.t) : []
  );

  function sectionLabel(id: string): string {
    return $i18n.t(sections.find((entry) => entry.id === id)?.label ?? 'settings.title');
  }

  function select(event: MouseEvent, nextSection: string, focus?: string): void {
    if (event.shiftKey || event.metaKey || event.ctrlKey || event.button !== 0) return;

    event.preventDefault();
    onSelect(nextSection, focus);
  }
</script>

{#snippet logoutRow()}
  <button
    type="button"
    class="settings-logout"
    onclick={() => void signOut.request(() => logoutWithPush(core, pushOverride()))}
  >
    <SignOutIcon aria-hidden="true" />
    <span>{$i18n.t('settings.logout')}</span>
  </button>
{/snippet}

{#snippet heading()}
  {$i18n.t('settings.title')}
{/snippet}

{#snippet nav(state: SettingsShellNav)}
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
            class="selection-layer"
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
      groups={groups.map((group) => ({
        id: group.id,
        label: group.label ? $i18n.t(group.label) : undefined,
        entries: group.entries.map((entry) => ({ ...entry, label: $i18n.t(entry.label) })),
      }))}
      activeId={state.openSection}
      ariaLabel={$i18n.t('settings.sections')}
      onSelect={select}
      href={(entry) => resolve(`settings/${entry.id}`)}
      showChevron={!state.desktop}
      large={!state.desktop}
      current={state.current}
      footer={logoutRow}
    />
  {/if}
{/snippet}

<SettingsShell
  section={section === null ? null : canonicalSection(section)}
  fallback={() => defaultSettingsSection()}
  label={$i18n.t('settings.title')}
  description={$i18n.t('settings.dialogDescription')}
  closeLabel={$i18n.t('settings.close')}
  backLabel={$i18n.t('settings.back')}
  {sectionLabel}
  {heading}
  {nav}
  {content}
  {onBack}
  {onClose}
/>

<SignOutWarningDialog guard={signOut} />

<style>
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
    padding: 0 var(--space-200) var(--space-300);
  }

  .search-field {
    align-items: center;
    background: var(--surface-var-container);
    border: var(--border-width) solid var(--surface-var-container-line);
    border-radius: var(--radius);
    display: flex;
    gap: var(--space-300);
    min-height: var(--control-height-medium);
    padding: 0 var(--space-300);
  }

  .search-field :global(svg) {
    color: var(--surface-var-on-container);
    flex: 0 0 auto;
    height: var(--icon-size-small);
    width: var(--icon-size-small);
  }

  .search-field:focus-within {
    border-color: var(--primary-main);
    box-shadow: inset 0 0 0 var(--border-width-600) var(--primary-main);
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
    color: var(--surface-var-on-container);
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
    color: var(--surface-var-on-container);
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
    font-size: var(--font-size-label);
    font-weight: var(--font-weight-medium);
    gap: var(--space-300);
    min-height: var(--control-height-medium);
    padding: 0 var(--space-300);
    text-decoration: none;
  }

  .search-results a:hover {
    background: var(--bg-container-hover);
  }

  .search-results a :global(svg) {
    height: var(--icon-size-small);
    width: var(--icon-size-small);
  }

  .settings-logout {
    align-items: center;
    background: transparent;
    border: 0;
    border-radius: var(--radius);
    color: var(--crit-main);
    cursor: pointer;
    display: flex;
    font: inherit;
    font-size: var(--font-size-label);
    font-weight: var(--font-weight-medium);
    gap: var(--space-300);
    min-height: var(--control-height-medium);
    padding: 0 var(--space-300);
    text-align: start;
    width: 100%;
  }

  .settings-logout:hover {
    background: var(--bg-container-hover);
  }

  .settings-logout:focus-visible {
    outline: var(--focus-ring-width) solid var(--focus-ring);
    outline-offset: calc(var(--focus-ring-width) * -1);
  }

  .settings-logout :global(svg) {
    flex: 0 0 auto;
    height: var(--icon-size-small);
    width: var(--icon-size-small);
  }

  :global(.settings-nav-paged) .search-results a {
    border-left: 0;
    min-height: var(--control-height-large);
  }

  :global(.settings-nav-paged) .settings-logout {
    min-height: var(--control-height-large);
  }
</style>
