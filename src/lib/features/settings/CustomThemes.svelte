<script lang="ts">
  import {
    customThemes,
    enableCustomTweak,
    installCustomTheme,
    installCustomTweak,
    selectCustomTheme,
    selectedCustomThemeId,
  } from '#lib/settings/custom-themes.svelte.js';
  import { pickFiles } from '#lib/platform/files.js';
  import Button from '#lib/ui/primitives/Button.svelte';
  import Select from '#lib/ui/primitives/Select.svelte';
  import Switch from '#lib/ui/primitives/Switch.svelte';
  import { i18n } from '#lib/i18n.js';
  import '#lib/ui/primitives/settings-row.css';

  type CatalogEntry = { basename: string; fullUrl: string };

  const catalogUrl = 'https://raw.githubusercontent.com/SableClient/themes/main/catalog.json';
  const themeKinds = ['light', 'dark'] as const;
  let catalog = $state.raw<CatalogEntry[]>([]);
  let tweakCatalog = $state.raw<CatalogEntry[]>([]);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let picker = $state<HTMLInputElement>();
  let catalogSelection = $state('');
  let tweakSelection = $state('');

  function metadata(css: string, fallback: string): { name: string; kind: 'light' | 'dark' } {
    const field = (name: string): string | undefined =>
      css.match(new RegExp(`^\\s*${name}:\\s*(.+)$`, 'im'))?.[1]?.trim();
    return { name: field('name') ?? fallback, kind: field('kind') === 'dark' ? 'dark' : 'light' };
  }

  function install(css: string, fallback: string): void {
    if (css.length > 1024 * 1024) {
      error = $i18n.t('settings.customThemesErrorSize');
      return;
    }
    if (css.includes('@sable-tweak')) {
      installCustomTweak({ id: crypto.randomUUID(), name: metadata(css, fallback).name, css });
      return;
    }
    if (!css.includes('@sable-theme')) {
      error = $i18n.t('settings.customThemesErrorHeader');
      return;
    }
    const theme = metadata(css, fallback);
    installCustomTheme({ id: crypto.randomUUID(), ...theme, css });
  }

  async function loadCatalog(): Promise<void> {
    loading = true;
    error = null;
    try {
      const response = await fetch(catalogUrl);
      const data: unknown = await response.json();
      if (
        !response.ok ||
        !data ||
        typeof data !== 'object' ||
        !Array.isArray((data as { themes?: unknown }).themes)
      ) {
        throw new Error('Catalog unavailable');
      }
      catalog = catalogEntries((data as { themes: unknown[] }).themes);
      tweakCatalog = catalogEntries((data as { tweaks?: unknown }).tweaks);
    } catch {
      error = $i18n.t('settings.customThemesErrorLoad');
      loading = false;
    }
  }

  function catalogEntries(rows: unknown): CatalogEntry[] {
    if (!Array.isArray(rows)) return [];
    return rows.filter(
      (row): row is CatalogEntry =>
        typeof row === 'object' &&
        row !== null &&
        typeof (row as CatalogEntry).basename === 'string' &&
        typeof (row as CatalogEntry).fullUrl === 'string'
    );
  }

  async function installFromCatalog(entry: CatalogEntry | undefined): Promise<void> {
    if (!entry) return;
    try {
      const response = await fetch(entry.fullUrl);
      if (!response.ok) throw new Error('unavailable');
      install(await response.text(), entry.basename);
    } catch {
      error = $i18n.t('settings.customThemesErrorInstall', { file: entry.basename });
    }
  }

  async function installCatalogTheme(): Promise<void> {
    await installFromCatalog(catalog.find((theme) => theme.fullUrl === catalogSelection));
    catalogSelection = '';
  }

  async function installCatalogTweak(): Promise<void> {
    await installFromCatalog(tweakCatalog.find((tweak) => tweak.fullUrl === tweakSelection));
    tweakSelection = '';
  }

  async function importFiles(files: FileList | File[]): Promise<void> {
    for (const file of files) {
      if (!file.name.endsWith('.sable.css')) {
        error = $i18n.t('settings.customThemesErrorChoose');
        continue;
      }
      install(await file.text(), file.name.replace(/\.sable\.css$/i, ''));
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
</script>

<section class="custom-themes settings-form" aria-labelledby="custom-themes-title">
  <div>
    <h3 id="custom-themes-title">{$i18n.t('settings.customThemes')}</h3>
    <p>{$i18n.t('settings.customThemesHint')}</p>
  </div>
  <div class="actions">
    <Button size="small" {loading} onclick={() => void loadCatalog()}
      >{$i18n.t('settings.customThemesBrowse')}</Button
    >
    <Button size="small" variant="secondary" onclick={() => void importTheme()}
      >{$i18n.t('settings.customThemesImport')}</Button
    >
    <input
      bind:this={picker}
      class="screen-reader-only"
      type="file"
      accept=".sable.css,text/css"
      onchange={(event) => void importFiles(event.currentTarget.files ?? [])}
    />
  </div>
  {#if catalog.length > 0}
    <Select
      bind:value={catalogSelection}
      aria-label={$i18n.t('settings.customThemesInstallTheme')}
      placeholder={$i18n.t('settings.customThemesChooseTheme')}
      items={[
        { value: '', label: $i18n.t('settings.customThemesChooseTheme') },
        ...catalog.map((theme) => ({ value: theme.fullUrl, label: theme.basename })),
      ]}
      onValueChange={() => void installCatalogTheme()}
    />
  {/if}
  {#if tweakCatalog.length > 0}
    <Select
      bind:value={tweakSelection}
      aria-label={$i18n.t('settings.customThemesInstallTweak')}
      placeholder={$i18n.t('settings.customThemesChooseTweak')}
      items={[
        { value: '', label: $i18n.t('settings.customThemesChooseTheme') },
        ...tweakCatalog.map((tweak) => ({ value: tweak.fullUrl, label: tweak.basename })),
      ]}
      onValueChange={() => void installCatalogTweak()}
    />
  {/if}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#if customThemes.themes.length > 0}
    <div class="theme-slots">
      {#each themeKinds as kind (kind)}
        <label>
          {kind === 'light'
            ? $i18n.t('settings.customThemesLightTheme')
            : $i18n.t('settings.customThemesDarkTheme')}
          <Select
            value={selectedCustomThemeId(kind) ?? ''}
            placeholder="Built-in"
            items={[
              { value: '', label: $i18n.t('settings.customThemesBuiltIn') },
              ...customThemes.themes
                .filter((theme) => theme.kind === kind)
                .map((theme) => ({ value: theme.id, label: theme.name })),
            ]}
            onValueChange={(value: string) => {
              selectCustomTheme(kind, value || null);
            }}
          />
        </label>
      {/each}
    </div>
  {/if}
  {#if customThemes.tweaks.length > 0}
    <ul class="tweaks">
      {#each customThemes.tweaks as tweak (tweak.id)}
        <li>
          <span>{tweak.name}</span>
          <Switch
            label={tweak.name}
            checked={customThemes.enabledTweakIds.includes(tweak.id)}
            onCheckedChange={(checked) => {
              enableCustomTweak(tweak.id, checked);
            }}
          />
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .custom-themes {
    display: grid;
    gap: var(--space-300);
  }

  h3,
  p {
    margin: 0;
  }

  h3 {
    font-size: var(--font-size-body);
  }

  p {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
  }

  .actions,
  .theme-slots {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-300);
  }

  .theme-slots label {
    display: grid;
    flex: 1 1 12rem;
    font-size: var(--font-size-small);
    gap: var(--space-100);
  }

  .tweaks {
    display: grid;
    gap: var(--space-200);
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .tweaks li {
    align-items: center;
    display: flex;
    font-size: var(--font-size-small);
    gap: var(--space-300);
    justify-content: space-between;
  }

  .error {
    color: var(--crit-main);
  }
</style>
