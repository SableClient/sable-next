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
  import SignOutWarningDialog from '#lib/features/sidebar/SignOutWarningDialog.svelte';
  import { SignOutGuard } from '#lib/features/sidebar/sign-out-guard.svelte.js';
  import { i18n } from '#lib/i18n.js';
  import {
    canonicalSection,
    findCategory,
    settingFocusId,
    settingsCategories,
  } from '#lib/settings/registry.js';
  import { createMasterDetail } from '#lib/ui/master-detail.svelte.js';
  import { shouldReduceMotion } from '#lib/ui/motion.js';
  import {
    finishSwipeGesture,
    startSwipeGesture,
    updateSwipeGesture,
    type SwipeGesture,
  } from '#lib/ui/swipe-gesture.js';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import SettingsNav from '#lib/ui/primitives/SettingsNav.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';
  import SettingsJumpSheet from './SettingsJumpSheet.svelte';
  import SettingsOutline from './SettingsOutline.svelte';
  import { findStandaloneSection, settingsNavGroups } from './sections.js';
  import { OutlineTracker } from './settings-outline.svelte.js';
  import { defaultSettingsSection } from './settings-navigation';
  import { searchSettings } from './settings-search.js';

  interface Props {
    section: string | null;
    onSelect: (section: string, focus?: string) => void;
    onBack: () => void;
    onClose: () => void;
    content: Snippet<[string]>;
  }

  let { section, onSelect, onBack, onClose, content: renderContent }: Props = $props();
  const SWIPE_IGNORE = '.slider, [data-sheet-no-drag]';
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
  const outline = new OutlineTracker();
  const pages = createMasterDetail(
    () => (section === null ? null : canonicalSection(section)),
    () => defaultSettingsSection()
  );
  let activeLabel = $derived(
    sections.find((entry) => entry.id === pages.openSection)?.label ?? 'settings.title'
  );

  let query = $state('');
  let trimmedQuery = $derived(query.trim());
  let results = $derived(
    trimmedQuery ? searchSettings(trimmedQuery, settingsCategories, $i18n.t) : []
  );

  let swipe: SwipeGesture | undefined;
  let swipeOffset = $state(0);
  let swiping = $state(false);
  let revealed = $state(false);
  let content = $state<HTMLElement | null>(null);

  function startSwipe(event: TouchEvent): void {
    const target = event.target instanceof Element ? event.target : null;
    swipe = target?.closest(SWIPE_IGNORE) ? undefined : startSwipeGesture(event, 0);
  }

  function moveSwipe(event: TouchEvent): void {
    if (!swipe) return;
    const update = updateSwipeGesture(swipe, event);
    if (!update || update.mode !== 'horizontal') return;
    swiping = true;
    revealed = true;
    swipeOffset = Math.max(0, update.distanceX);
  }

  function finishSwipe(cancelled: boolean): void {
    const active = swipe;
    swipe = undefined;
    swiping = false;
    if (!active) return;
    const offset = swipeOffset;
    swipeOffset = 0;
    const result = finishSwipeGesture(active, offset, cancelled);
    if (!result.handled) return;
    const width = content?.clientWidth ?? 0;
    if (result.direction === 'right' || (result.direction === undefined && offset > width / 2)) {
      revealed = false;
      onBack();
      return;
    }
    if (offset === 0 || shouldReduceMotion()) revealed = false;
  }

  function select(event: MouseEvent, nextSection: string, focus?: string): void {
    if (event.shiftKey || event.metaKey || event.ctrlKey || event.button !== 0) return;

    event.preventDefault();
    onSelect(nextSection, focus);
  }
</script>

{#snippet currentOutline(entry: { label: string })}
  {#if outline.entries.length > 0}
    <SettingsOutline {outline} label={$i18n.t('settings.outlineLabel', { section: entry.label })} />
  {/if}
{/snippet}

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

<div class="settings-shell" class:paged={!pages.desktop}>
  <Dialog.Description class="screen-reader-only">
    {$i18n.t('settings.dialogDescription')}
  </Dialog.Description>

  {#if pages.showList || revealed}
    <aside
      class="settings-nav"
      class:settings-nav-paged={!pages.desktop}
      aria-label={$i18n.t('settings.title')}
    >
      <div class="settings-title settings-nav-header">
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
          activeId={pages.openSection}
          ariaLabel={$i18n.t('settings.sections')}
          onSelect={select}
          href={(entry) => resolve(`settings/${entry.id}`)}
          showChevron={!pages.desktop}
          large={!pages.desktop}
          current={pages.desktop ? currentOutline : undefined}
          footer={logoutRow}
        />
      {/if}
    </aside>
  {/if}

  {#if pages.showContent && pages.openSection}
    <section
      class="settings-content"
      aria-label={$i18n.t(activeLabel)}
      class:swiping
      class:swiped={revealed}
      style:transform={swipeOffset > 0 ? `translateX(${String(swipeOffset)}px)` : undefined}
      bind:this={content}
      ontouchstart={pages.desktop ? undefined : startSwipe}
      ontouchmove={pages.desktop ? undefined : moveSwipe}
      ontouchend={pages.desktop ? undefined : () => finishSwipe(false)}
      ontouchcancel={pages.desktop ? undefined : () => finishSwipe(true)}
      ontransitionend={(event) => {
        if (event.target === event.currentTarget && !swiping) revealed = false;
      }}
    >
      {#if !pages.desktop}
        <div class="settings-title section-bar settings-nav-header">
          <IconButton variant="ghost" size="small" label={$i18n.t('settings.back')} onclick={onBack}
            ><ArrowLeftIcon /></IconButton
          >
          <Dialog.Title class="settings-heading">
            {#if outline.entries.length > 1}
              <SettingsJumpSheet {outline} title={$i18n.t(activeLabel)} />
            {:else}
              {$i18n.t(activeLabel)}
            {/if}
          </Dialog.Title>
          <IconButton
            variant="ghost"
            size="small"
            label={$i18n.t('settings.close')}
            onclick={onClose}><XIcon /></IconButton
          >
        </div>
      {/if}
      {#key pages.openSection}
        <div class="settings-scroll" {@attach outline.track}>
          {@render renderContent(pages.openSection)}
        </div>
      {/key}
    </section>
  {/if}
</div>

<SignOutWarningDialog guard={signOut} />

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

  .settings-content {
    --ghost-hover: var(--surface-container-hover);
    --ghost-active: var(--surface-container-active);

    background: var(--surface-container);
    display: flex;
    flex-direction: column;
    height: 100%;
    min-width: 0;
    width: 100%;
  }

  .paged {
    position: relative;
  }

  .paged .settings-content.swiped {
    box-shadow: var(--shadow-dialog);
    inset: 0;
    position: absolute;
  }

  .paged .settings-content:not(.swiping) {
    transition: transform var(--duration-fast) var(--ease-smooth-out);
  }

  .settings-scroll {
    flex: 1;
    min-height: 0;
    overflow: auto;
  }

  .section-bar {
    background: var(--surface-container);
    border-bottom: var(--border-width) solid var(--surface-container-line);
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

  .paged .settings-scroll :global(.app-page-header) {
    padding-inline: var(--space-400);
  }

  .paged .settings-scroll :global(.app-page-header h1) {
    border: 0;
    clip-path: inset(50%);
    height: 1px;
    overflow: hidden;
    padding: 0;
    position: absolute;
    white-space: nowrap;
    width: 1px;
  }

  .paged .search-results a {
    border-left: 0;
    min-height: var(--control-height-large);
  }

  .paged .settings-logout {
    min-height: var(--control-height-large);
  }
</style>
