<script lang="ts">
  import XIcon from 'phosphor-svelte/lib/XIcon';
  import { untrack } from 'svelte';

  import { i18n } from '#lib/i18n.js';
  import {
    customThemes,
    selectedCustomThemeId,
    type CustomTheme,
    type ThemePreview,
  } from '#lib/settings/custom-themes.svelte.js';
  import type { ResolvedTheme } from '#lib/settings/theme.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import DialogFrame from '#lib/ui/primitives/DialogFrame.svelte';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';

  import ThemeTile from './ThemeTile.svelte';
  import {
    entryName,
    filterCatalog,
    loadCatalog,
    type CatalogEntry,
    type CatalogFilter,
  } from './theme-catalog';

  interface Props {
    open?: boolean;
    installing: string | null;
    previewing: string | null;
    preview: ThemePreview | null;
    oninstall: (entry: CatalogEntry) => void;
    onpreview: (entry: CatalogEntry) => void;
    onkeep: () => void;
    onrevert: () => void;
    onuse: (theme: CustomTheme) => void;
    onimport: () => void;
    initialTab?: 'theme' | 'tweak';
  }

  let {
    open = $bindable(false),
    installing,
    previewing,
    preview,
    oninstall,
    onpreview,
    onkeep,
    onrevert,
    onuse,
    onimport,
    initialTab = 'theme',
  }: Props = $props();

  let entries = $state.raw<CatalogEntry[]>([]);
  let loading = $state(false);
  let failed = $state(false);
  let requested = false;
  const filter = $state<CatalogFilter>({ query: '', kind: 'all', highContrast: false });

  let tab = $state<'theme' | 'tweak'>(untrack(() => initialTab));
  let themes = $derived(entries.filter((entry) => entry.kind === 'theme'));
  let tweaks = $derived(entries.filter((entry) => entry.kind === 'tweak'));
  let shownThemes = $derived(filterCatalog(themes, filter));
  let shownTweaks = $derived(
    filterCatalog(tweaks, { query: filter.query, kind: 'all', highContrast: false })
  );

  const tabs = [
    { value: 'theme', label: 'settings.themeCatalogThemesTab' },
    { value: 'tweak', label: 'settings.themeCatalogTweaksTab' },
  ] as const;

  function moveTab(event: KeyboardEvent): void {
    const next =
      event.key === 'Home'
        ? 'theme'
        : event.key === 'End'
          ? 'tweak'
          : event.key === 'ArrowLeft' || event.key === 'ArrowRight'
            ? tab === 'theme'
              ? 'tweak'
              : 'theme'
            : null;
    if (next === null) return;
    event.preventDefault();
    tab = next;
    document.getElementById(`catalog-tab-${tab}`)?.focus();
  }

  function modeName(kind: ResolvedTheme): string {
    return (
      kind === 'light'
        ? $i18n.t('settings.customThemesLightSlot')
        : $i18n.t('settings.customThemesDarkSlot')
    ).toLowerCase();
  }

  function clearFilters(): void {
    filter.query = '';
    filter.kind = 'all';
    filter.highContrast = false;
  }

  const kinds = [
    { value: 'all', label: 'settings.themeCatalogAll' },
    { value: 'light', label: 'settings.customThemesLightTheme' },
    { value: 'dark', label: 'settings.customThemesDarkTheme' },
  ] as const;

  $effect(() => {
    if (!open || requested) return;
    requested = true;
    untrack(() => void load());
  });

  async function load(): Promise<void> {
    loading = true;
    failed = false;
    try {
      await loadCatalog((entry) => {
        entries = [...entries, entry];
      });
    } catch (reason) {
      console.debug('[sable themes] catalog unavailable', reason);
      failed = true;
    } finally {
      loading = false;
    }
  }

  function installedTheme(entry: CatalogEntry): CustomTheme | undefined {
    return customThemes.themes.find((theme) => theme.source === entry.fullUrl);
  }

  function tweakInstalled(entry: CatalogEntry): boolean {
    return customThemes.tweaks.some((tweak) => tweak.source === entry.fullUrl);
  }

  function detail(entry: CatalogEntry): string {
    const kind =
      entry.kind === 'tweak'
        ? entry.meta.description
        : entry.meta.kind === 'dark'
          ? $i18n.t('settings.customThemesDarkTheme')
          : $i18n.t('settings.customThemesLightTheme');
    const author = entry.meta.author
      ? $i18n.t('settings.themeBy', { author: entry.meta.author })
      : null;
    return [kind, author].filter((part) => part !== null && part !== '').join(' · ');
  }
</script>

<DialogFrame bind:open variant="verification" label={$i18n.t('settings.themeCatalogTitle')}>
  <div class="catalog" aria-busy={loading}>
    <header class="catalog-head">
      <div class="catalog-title">
        <h2>{$i18n.t('settings.themeCatalogTitle')}</h2>
        <IconButton
          variant="ghost"
          size="small"
          label={$i18n.t('settings.themeCatalogClose')}
          onclick={() => {
            open = false;
          }}><XIcon /></IconButton
        >
      </div>
      <p class="catalog-hint">{$i18n.t('settings.themeCatalogTrust')}</p>
      <div class="tabs" role="tablist" aria-label={$i18n.t('settings.themeCatalogTitle')}>
        {#each tabs as option (option.value)}
          {@const count = option.value === 'theme' ? themes.length : tweaks.length}
          <button
            type="button"
            role="tab"
            id={`catalog-tab-${option.value}`}
            class="tab"
            aria-selected={tab === option.value}
            aria-controls={`catalog-panel-${option.value}`}
            tabindex={tab === option.value ? 0 : -1}
            onclick={() => (tab = option.value)}
            onkeydown={moveTab}
          >
            {$i18n.t(option.label)}
            {#if count > 0}<span class="tab-count">{count}</span>{/if}
          </button>
        {/each}
      </div>
      <TextInput
        type="search"
        bind:value={filter.query}
        placeholder={$i18n.t('settings.themeCatalogSearch')}
        aria-label={$i18n.t('settings.themeCatalogSearch')}
      />
      {#if tab === 'theme'}<div
          class="chips"
          role="group"
          aria-label={$i18n.t('settings.themeCatalogFilters')}
        >
          {#each kinds as option (option.value)}
            <button
              type="button"
              class="chip"
              aria-pressed={filter.kind === option.value}
              onclick={() => (filter.kind = option.value)}
            >
              {$i18n.t(option.label)}
            </button>
          {/each}
          <button
            type="button"
            class="chip"
            aria-pressed={filter.highContrast}
            onclick={() => (filter.highContrast = !filter.highContrast)}
          >
            {$i18n.t('settings.themeCatalogHighContrast')}
          </button>
        </div>{/if}
    </header>

    {#if failed}
      <Alert variant="warning">
        <p>{$i18n.t('settings.customThemesErrorLoad')}</p>
        <Button variant="secondary" size="small" onclick={() => void load()}>
          {$i18n.t('settings.themeCatalogRetry')}
        </Button>
      </Alert>
    {:else}
      {#if tab === 'theme'}<div
          class="catalog-group"
          role="tabpanel"
          id="catalog-panel-theme"
          aria-labelledby="catalog-tab-theme"
        >
          {#if shownThemes.length > 0}
            <ul class="tiles">
              {#each shownThemes as entry (entry.fullUrl)}
                {@const theme = installedTheme(entry)}
                {@const used =
                  theme !== undefined && selectedCustomThemeId(theme.kind) === theme.id}
                {@const kind = entry.meta.kind}
                <li>
                  <ThemeTile
                    name={entryName(entry)}
                    detail={detail(entry)}
                    swatches={entry.swatches}
                    selected={preview?.source === entry.fullUrl}
                    role="button"
                    onselect={() => {
                      onpreview(entry);
                    }}
                  >
                    {#snippet actions()}
                      {#if used}
                        <span class="state">
                          {$i18n.t('settings.themeInUseFor', { mode: modeName(kind) })}
                        </span>
                      {:else}
                        <Button
                          size="small"
                          variant="secondary"
                          loading={installing === entry.fullUrl || previewing === entry.fullUrl}
                          disabled={installing !== null}
                          onclick={() => {
                            if (theme) onuse(theme);
                            else oninstall(entry);
                          }}
                        >
                          {theme
                            ? $i18n.t('settings.themeUseFor', { mode: modeName(kind) })
                            : $i18n.t('settings.themeInstallUse')}
                        </Button>
                      {/if}
                    {/snippet}
                  </ThemeTile>
                </li>
              {/each}
            </ul>
          {:else if loading}
            <ul class="tiles" aria-hidden="true">
              {#each [0, 1, 2, 3] as index (index)}
                <li class="skeleton"></li>
              {/each}
            </ul>
          {:else}
            <div class="empty">
              <p>{$i18n.t('settings.themeCatalogEmpty')}</p>
              <Button variant="ghost" size="small" onclick={clearFilters}>
                {$i18n.t('settings.themeCatalogClear')}
              </Button>
            </div>
          {/if}
        </div>
      {:else}
        <div
          class="catalog-group"
          role="tabpanel"
          id="catalog-panel-tweak"
          aria-labelledby="catalog-tab-tweak"
        >
          <p class="catalog-hint">{$i18n.t('settings.themeCatalogTweaksHint')}</p>
          {#if shownTweaks.length > 0}
            <ul class="tweaks">
              {#each shownTweaks as entry (entry.fullUrl)}
                {@const installed = tweakInstalled(entry)}
                <li class="tweak">
                  <span class="tweak-copy">
                    <span class="tweak-name">{entryName(entry)}</span>
                    <span class="tweak-detail">{detail(entry)}</span>
                  </span>
                  {#if installed}
                    <span class="state">{$i18n.t('settings.themeFileInstalled')}</span>
                  {:else}
                    <Button
                      size="small"
                      variant="secondary"
                      loading={installing === entry.fullUrl}
                      disabled={installing !== null}
                      onclick={() => {
                        oninstall(entry);
                      }}
                    >
                      {$i18n.t('settings.themeFileInstall')}
                    </Button>
                  {/if}
                </li>
              {/each}
            </ul>
          {:else if loading}
            <ul class="tweaks" aria-hidden="true">
              {#each [0, 1, 2] as index (index)}<li class="tweak skeleton-row"></li>{/each}
            </ul>
          {:else}
            <p class="empty">{$i18n.t('settings.themeCatalogEmpty')}</p>
          {/if}
        </div>
      {/if}
    {/if}

    {#if preview}
      <div class="preview-bar" role="status">
        <span class="preview-copy">
          {$i18n.t('settings.themePreviewing', {
            name: preview.name,
            mode: modeName(preview.kind),
          })}
        </span>
        <Button variant="ghost" size="small" onclick={onrevert}>
          {$i18n.t('settings.themePreviewRevert')}
        </Button>
        <Button variant="primary" size="small" onclick={onkeep}>
          {$i18n.t('settings.themePreviewKeep')}
        </Button>
      </div>
    {/if}

    <footer class="catalog-foot">
      <Button variant="ghost" size="small" onclick={onimport}>
        {$i18n.t('settings.customThemesImportFile')}
      </Button>
    </footer>
  </div>
</DialogFrame>

<style>
  .catalog {
    --catalog-inset: var(--space-400);

    display: grid;
    gap: var(--space-400);
    width: min(44rem, calc(100vw - 2rem));
  }

  @media (width >= 42rem) {
    .catalog {
      --catalog-inset: var(--space-500);
    }
  }

  .catalog-head {
    background: var(--surface-container);
    border-bottom: var(--border-width) solid var(--surface-container-line);
    display: grid;
    gap: var(--space-300);
    inset-block-start: calc(var(--catalog-inset) * -1);
    margin-block-start: calc(var(--catalog-inset) * -1);
    margin-inline: calc(var(--catalog-inset) * -1);
    padding: var(--catalog-inset) var(--catalog-inset) var(--space-300);
    position: sticky;
    z-index: 1;
  }

  .catalog-title {
    align-items: center;
    display: flex;
    justify-content: space-between;
  }

  h2,
  p {
    margin: 0;
  }

  h2 {
    font-size: var(--font-size-heading);
    line-height: var(--line-height-heading);
  }

  .catalog-hint,
  .empty {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    max-width: 60ch;
  }

  .tabs {
    border-bottom: var(--border-width) solid var(--surface-container-line);
    display: flex;
    gap: var(--space-400);
  }

  .tab {
    align-items: center;
    background: transparent;
    border: 0;
    border-bottom: var(--border-width-600) solid transparent;
    color: var(--surface-var-on-container);
    cursor: pointer;
    display: inline-flex;
    font: inherit;
    font-size: var(--font-size-label);
    font-weight: var(--font-weight-medium);
    gap: var(--space-200);
    margin-block-end: calc(var(--border-width) * -1);
    min-height: var(--target-hit);
    padding: 0 var(--space-100);
  }

  .tab:hover {
    color: var(--surface-on-container);
  }

  .tab:focus-visible {
    outline: var(--focus-ring-width) solid var(--focus-ring);
    outline-offset: calc(var(--focus-ring-width) * -1);
  }

  .tab[aria-selected='true'] {
    border-bottom-color: var(--primary-main);
    color: var(--surface-on-container);
  }

  .tab-count {
    background: var(--surface-var-container);
    border-radius: var(--radii-pill);
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    padding: 0 var(--space-200);
  }

  .skeleton-row {
    background: var(--surface-var-container);
    border-radius: var(--radius);
    margin-block: var(--space-100);
  }

  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-200);
  }

  .chip {
    background: transparent;
    border: var(--border-width) solid var(--surface-container-line);
    border-radius: var(--radii-pill);
    color: inherit;
    cursor: pointer;
    font: inherit;
    font-size: var(--font-size-small);
    min-height: max(var(--control-height-300), var(--target-hit));
    padding: 0 var(--space-400);
  }

  .chip:hover {
    background: var(--surface-container-hover);
  }

  .chip:focus-visible {
    outline: var(--focus-ring-width) solid var(--focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  .chip[aria-pressed='true'] {
    background: var(--primary-container);
    border-color: var(--primary-container-line);
    color: var(--primary-on-container);
    font-weight: var(--font-weight-medium);
  }

  .catalog-group {
    display: grid;
    gap: var(--space-300);
  }

  .tiles {
    display: grid;
    gap: var(--space-400);
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 9.5rem), 1fr));
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .skeleton {
    aspect-ratio: 16 / 10;
    background: var(--surface-var-container);
    border-radius: var(--radius);
  }

  @media (prefers-reduced-motion: no-preference) {
    .skeleton {
      animation: skeleton-pulse var(--duration-slow) ease-in-out infinite alternate;
    }
  }

  .state {
    color: var(--primary-main);
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-medium);
  }

  .tweaks {
    display: grid;
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .tweak {
    align-items: center;
    display: flex;
    gap: var(--space-300);
    min-height: var(--target-hit);
    padding-block: var(--space-200);
  }

  .tweak + .tweak {
    border-top: var(--border-width) solid var(--surface-container-line);
  }

  .tweak-copy {
    display: grid;
    flex: 1;
    min-width: 0;
  }

  .tweak-name {
    font-size: var(--font-size-label);
    font-weight: var(--font-weight-medium);
  }

  .tweak-detail {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    overflow-wrap: anywhere;
  }

  .preview-bar {
    align-items: center;
    background: var(--surface-container);
    border-top: var(--border-width) solid var(--surface-container-line);
    bottom: calc(var(--catalog-inset) * -1);
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-200);
    margin: 0 calc(var(--catalog-inset) * -1) calc(var(--catalog-inset) * -1);
    padding: var(--space-300) var(--catalog-inset) var(--catalog-inset);
    position: sticky;
    z-index: 1;
  }

  .preview-copy {
    flex: 1 1 12rem;
    font-size: var(--font-size-label);
    font-weight: var(--font-weight-medium);
  }

  .empty {
    align-items: center;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-200);
  }

  .empty p {
    margin: 0;
  }

  .catalog-head :global(.text-input) {
    min-height: max(var(--control-height-medium), var(--target-hit));
  }

  .catalog-foot {
    display: flex;
    justify-content: flex-start;
  }
</style>
