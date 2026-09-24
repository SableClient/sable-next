<script lang="ts">
  import CheckIcon from 'phosphor-svelte/lib/CheckIcon';
  import PaletteIcon from 'phosphor-svelte/lib/PaletteIcon';
  import TrashIcon from 'phosphor-svelte/lib/TrashIcon';

  import {
    customThemes,
    enableCustomTweak,
    installCustomTheme,
    installCustomTweak,
    removeCustomTheme,
    removeCustomTweak,
    selectCustomTheme,
    selectedCustomThemeId,
    type CustomTheme,
  } from '#lib/settings/custom-themes.svelte.js';
  import {
    isThemeFileName,
    parseThemeFile,
    themeFileBaseName,
    themeFileMetadata,
    themeSwatches,
  } from '#lib/settings/theme-file.js';
  import { pickFiles } from '#lib/platform/files.js';
  import Button from '#lib/ui/primitives/Button.svelte';
  import ConfirmDialog from '#lib/ui/primitives/ConfirmDialog.svelte';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import Switch from '#lib/ui/primitives/Switch.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';
  import { i18n } from '#lib/i18n.js';
  import '#lib/ui/primitives/settings-row.css';

  import {
    describeCatalog,
    entryName,
    fetchCatalog,
    filterCatalog,
    type CatalogEntry,
    type CatalogFilter,
  } from './theme-catalog';

  let entries = $state.raw<CatalogEntry[]>([]);
  let browsing = $state(false);
  let loading = $state(false);
  let installing = $state<string | null>(null);
  let error = $state<string | null>(null);
  let picker = $state<HTMLInputElement>();
  const filter = $state<CatalogFilter>({ query: '', kind: 'all', highContrast: false });
  let pendingRemoval = $state.raw<{ kind: 'theme' | 'tweak'; id: string; name: string } | null>(
    null
  );

  let shown = $derived(filterCatalog(entries, filter));
  let shownThemes = $derived(shown.filter((entry) => entry.kind === 'theme'));
  let shownTweaks = $derived(shown.filter((entry) => entry.kind === 'tweak'));
  let tweaksShown = $derived(filter.kind === 'all' && !filter.highContrast);
  let installedSources = $derived(
    new Set(
      [...customThemes.themes, ...customThemes.tweaks].flatMap((item) =>
        item.source ? [item.source] : []
      )
    )
  );

  const kinds = [
    { value: 'all', label: 'settings.themeCatalogAll' },
    { value: 'light', label: 'settings.customThemesLightTheme' },
    { value: 'dark', label: 'settings.customThemesDarkTheme' },
  ] as const;

  function install(css: string, fallback: string, source?: string): void {
    const parsed = parseThemeFile(css, fallback);
    if (parsed === 'size') error = $i18n.t('settings.customThemesErrorSize');
    else if (parsed === 'header') error = $i18n.t('settings.customThemesErrorHeader');
    else if (parsed.kind === 'tweak') installCustomTweak({ ...parsed.tweak, source });
    else installCustomTheme({ ...parsed.theme, source });
  }

  async function browse(): Promise<void> {
    browsing = !browsing;
    if (!browsing || entries.length > 0 || loading) return;
    loading = true;
    error = null;
    try {
      const catalog = await fetchCatalog();
      const add = (entry: CatalogEntry): void => {
        entries = [...entries, entry];
      };
      await Promise.all([
        describeCatalog('theme', catalog.themes, add),
        describeCatalog('tweak', catalog.tweaks, add),
      ]);
    } catch (reason) {
      console.debug('[sable themes] catalog unavailable', reason);
      error = $i18n.t('settings.customThemesErrorLoad');
    } finally {
      loading = false;
    }
  }

  async function installFromCatalog(entry: CatalogEntry): Promise<void> {
    installing = entry.fullUrl;
    try {
      const response = await fetch(entry.fullUrl);
      if (!response.ok) throw new Error('unavailable');
      install(await response.text(), entry.basename, entry.fullUrl);
    } catch {
      error = $i18n.t('settings.customThemesErrorInstall', { file: entryName(entry) });
    } finally {
      installing = null;
    }
  }

  async function importFiles(files: FileList | File[]): Promise<void> {
    for (const file of files) {
      if (!isThemeFileName(file.name)) {
        error = $i18n.t('settings.customThemesErrorChoose');
        continue;
      }
      install(await file.text(), themeFileBaseName(file.name));
    }
  }

  async function importTheme(): Promise<void> {
    const files = await pickFiles('*');
    if (files) {
      await importFiles(files);
    } else {
      picker?.click();
    }
  }

  function inUse(theme: CustomTheme): boolean {
    return selectedCustomThemeId(theme.kind) === theme.id;
  }

  function entryDetail(entry: CatalogEntry): string {
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

  function confirmRemoval(): void {
    if (pendingRemoval?.kind === 'theme') removeCustomTheme(pendingRemoval.id);
    else if (pendingRemoval?.kind === 'tweak') removeCustomTweak(pendingRemoval.id);
    pendingRemoval = null;
  }
</script>

{#snippet swatches(colors: readonly string[])}
  <span class="swatches" aria-hidden="true">
    {#each colors as color, index (index)}
      <span class="swatch" style:background={color}></span>
    {:else}
      <PaletteIcon />
    {/each}
  </span>
{/snippet}

{#snippet catalogCard(entry: CatalogEntry)}
  {@const installed = installedSources.has(entry.fullUrl)}
  <li class="card">
    {#if entry.kind === 'theme'}{@render swatches(entry.swatches)}{/if}
    <span class="identity">
      <span class="name">{entryName(entry)}</span>
      <span class="meta">{entryDetail(entry)}</span>
    </span>
    <Button
      size="small"
      variant="secondary"
      disabled={installed || installing === entry.fullUrl}
      loading={installing === entry.fullUrl}
      onclick={() => void installFromCatalog(entry)}
    >
      {installed ? $i18n.t('settings.themeFileInstalled') : $i18n.t('settings.themeFileInstall')}
    </Button>
  </li>
{/snippet}

<section class="custom-themes settings-form" aria-labelledby="custom-themes-title">
  <div>
    <h3 id="custom-themes-title">{$i18n.t('settings.customThemes')}</h3>
    <p>{$i18n.t('settings.customThemesHint')}</p>
  </div>
  <div class="actions">
    <Button size="small" aria-expanded={browsing} onclick={() => void browse()}>
      {browsing ? $i18n.t('settings.themeCatalogClose') : $i18n.t('settings.customThemesBrowse')}
    </Button>
    <Button size="small" variant="secondary" onclick={() => void importTheme()}>
      {$i18n.t('settings.customThemesImport')}
    </Button>
    <input
      bind:this={picker}
      class="screen-reader-only"
      type="file"
      accept=".sable.css,text/css"
      onchange={(event) => void importFiles(event.currentTarget.files ?? [])}
    />
  </div>
  {#if error}<p class="error" role="alert">{error}</p>{/if}

  {#if customThemes.themes.length > 0}
    <h4>{$i18n.t('settings.customThemesInstalled')}</h4>
    <ul class="cards">
      {#each customThemes.themes as theme (theme.id)}
        {@const used = inUse(theme)}
        <li class="card">
          {@render swatches(themeSwatches(theme.css))}
          <span class="identity">
            <span class="name">{theme.name}</span>
            <span class="meta">
              {theme.kind === 'light'
                ? $i18n.t('settings.customThemesLightTheme')
                : $i18n.t('settings.customThemesDarkTheme')}
            </span>
          </span>
          <Button
            size="small"
            variant="secondary"
            class="choice"
            aria-pressed={used}
            onclick={() => {
              selectCustomTheme(theme.kind, used ? null : theme.id);
            }}
          >
            {#if used}<CheckIcon />{/if}
            {used ? $i18n.t('settings.themeInUse') : $i18n.t('settings.themeUse')}
          </Button>
          <IconButton
            variant="ghost"
            size="small"
            label={$i18n.t('settings.customThemesRemove', { name: theme.name })}
            onclick={() => {
              pendingRemoval = { kind: 'theme', id: theme.id, name: theme.name };
            }}
          >
            <TrashIcon />
          </IconButton>
        </li>
      {/each}
    </ul>
  {/if}

  {#if customThemes.tweaks.length > 0}
    <h4>{$i18n.t('settings.customTweaksInstalled')}</h4>
    <ul class="cards">
      {#each customThemes.tweaks as tweak (tweak.id)}
        {@const description = themeFileMetadata(tweak.css).description}
        <li class="card">
          <span class="identity">
            <span class="name">{tweak.name}</span>
            {#if description}<span class="meta">{description}</span>{/if}
          </span>
          <Switch
            label={tweak.name}
            checked={customThemes.enabledTweakIds.includes(tweak.id)}
            onCheckedChange={(checked) => {
              enableCustomTweak(tweak.id, checked);
            }}
          />
          <IconButton
            variant="ghost"
            size="small"
            label={$i18n.t('settings.customThemesRemove', { name: tweak.name })}
            onclick={() => {
              pendingRemoval = { kind: 'tweak', id: tweak.id, name: tweak.name };
            }}
          >
            <TrashIcon />
          </IconButton>
        </li>
      {/each}
    </ul>
  {/if}

  {#if browsing}
    <div class="catalog" aria-busy={loading}>
      <TextInput
        type="search"
        bind:value={filter.query}
        placeholder={$i18n.t('settings.themeCatalogSearch')}
        aria-label={$i18n.t('settings.themeCatalogSearch')}
      />
      <div class="chips" role="group" aria-label={$i18n.t('settings.themeCatalogFilters')}>
        {#each kinds as option (option.value)}
          <Button
            size="small"
            variant="secondary"
            class="choice"
            aria-pressed={filter.kind === option.value}
            onclick={() => (filter.kind = option.value)}
          >
            {$i18n.t(option.label)}
          </Button>
        {/each}
        <Button
          size="small"
          variant="secondary"
          class="choice"
          aria-pressed={filter.highContrast}
          onclick={() => (filter.highContrast = !filter.highContrast)}
        >
          {$i18n.t('settings.themeCatalogHighContrast')}
        </Button>
      </div>

      <h4>{$i18n.t('settings.themeCatalogThemes')}</h4>
      {#if shownThemes.length > 0}
        <ul class="cards">
          {#each shownThemes as entry (entry.fullUrl)}{@render catalogCard(entry)}{/each}
        </ul>
      {:else if !loading}
        <p>{$i18n.t('settings.themeCatalogEmpty')}</p>
      {/if}

      {#if tweaksShown}
        <h4>{$i18n.t('settings.themeCatalogTweaks')}</h4>
        {#if shownTweaks.length > 0}
          <ul class="cards">
            {#each shownTweaks as entry (entry.fullUrl)}{@render catalogCard(entry)}{/each}
          </ul>
        {:else if !loading}
          <p>{$i18n.t('settings.themeCatalogEmpty')}</p>
        {/if}
      {/if}
    </div>
  {/if}
</section>

<ConfirmDialog
  open={pendingRemoval !== null}
  onOpenChange={(next: boolean) => {
    if (!next) pendingRemoval = null;
  }}
  title={$i18n.t('settings.customThemesRemoveTitle', { name: pendingRemoval?.name ?? '' })}
  description={$i18n.t('settings.customThemesRemoveHint')}
  confirmLabel={$i18n.t('settings.customThemesRemove', { name: pendingRemoval?.name ?? '' })}
  onConfirm={confirmRemoval}
/>

<style>
  .custom-themes {
    display: grid;
    gap: var(--space-300);
  }

  h3,
  h4,
  p {
    margin: 0;
  }

  h3 {
    font-size: var(--font-size-body);
  }

  h4 {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-medium);
  }

  p {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
  }

  .actions,
  .chips {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-200);
  }

  .catalog {
    display: grid;
    gap: var(--space-300);
  }

  .cards {
    display: grid;
    gap: var(--space-200);
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 18rem), 1fr));
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .card {
    align-items: center;
    background: var(--surface-var-container);
    border: var(--border-width) solid var(--surface-container-line);
    border-radius: var(--radius);
    display: flex;
    gap: var(--space-300);
    min-width: 0;
    padding: var(--space-200) var(--space-300);
  }

  .swatches {
    color: var(--surface-var-on-container);
    display: flex;
    flex: none;
  }

  .swatch {
    border: var(--border-width) solid var(--surface-container-line);
    border-radius: var(--radii-round);
    height: 1.25rem;
    width: 1.25rem;
  }

  .swatch + .swatch {
    margin-inline-start: calc(var(--space-150) * -1);
  }

  .identity {
    display: grid;
    flex: 1;
    min-width: 0;
  }

  .name,
  .meta {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .name {
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-medium);
  }

  .meta {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
  }

  .error {
    color: var(--crit-main);
  }
</style>
