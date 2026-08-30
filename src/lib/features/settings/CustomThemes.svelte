<script lang="ts">
  import {
    customThemes,
    installCustomTheme,
    selectCustomTheme,
    selectedCustomThemeId,
  } from '#lib/settings/custom-themes.svelte.js';
  import { pickFiles } from '#lib/platform/files.js';
  import Button from '#lib/ui/primitives/Button.svelte';
  import Select from '#lib/ui/primitives/Select.svelte';

  type CatalogTheme = { basename: string; fullUrl: string };

  const catalogUrl = 'https://raw.githubusercontent.com/SableClient/themes/main/catalog.json';
  const themeKinds = ['light', 'dark'] as const;
  let catalog = $state.raw<CatalogTheme[]>([]);
  let loading = $state(false);
  let error = $state<string | null>(null);
  let picker = $state<HTMLInputElement>();
  let catalogSelection = $state('');

  function metadata(css: string, fallback: string): { name: string; kind: 'light' | 'dark' } {
    const field = (name: string): string | undefined =>
      css.match(new RegExp(`^\\s*${name}:\\s*(.+)$`, 'im'))?.[1]?.trim();
    return { name: field('name') ?? fallback, kind: field('kind') === 'dark' ? 'dark' : 'light' };
  }

  function install(css: string, fallback: string): void {
    if (css.length > 1024 * 1024) {
      error = 'Themes must be smaller than 1 MiB.';
      return;
    }
    if (!css.includes('@sable-theme')) {
      error = 'This file is not a Sable theme. It must include @sable-theme metadata.';
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
      catalog = (data as { themes: unknown[] }).themes.filter(
        (theme): theme is CatalogTheme =>
          typeof theme === 'object' &&
          theme !== null &&
          typeof (theme as CatalogTheme).basename === 'string' &&
          typeof (theme as CatalogTheme).fullUrl === 'string'
      );
    } catch {
      error = 'Could not load the official theme catalog.';
    } finally {
      loading = false;
    }
  }

  async function installCatalog(): Promise<void> {
    const entry = catalog.find((theme) => theme.fullUrl === catalogSelection);
    if (!entry) return;
    try {
      const response = await fetch(entry.fullUrl);
      if (!response.ok) throw new Error('theme unavailable');
      install(await response.text(), entry.basename);
    } catch {
      error = `Could not install ${entry.basename}.`;
    } finally {
      catalogSelection = '';
    }
  }

  async function importFiles(files: FileList | File[]): Promise<void> {
    for (const file of files) {
      if (!file.name.endsWith('.sable.css')) {
        error = 'Choose a .sable.css theme file.';
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

<section class="custom-themes" aria-labelledby="custom-themes-title">
  <div>
    <h3 id="custom-themes-title">Custom themes</h3>
    <p>
      Install a theme from Sable's official catalog or import a local <code>.sable.css</code> file. Only
      import CSS you trust.
    </p>
  </div>
  <div class="actions">
    <Button size="small" {loading} onclick={() => void loadCatalog()}>Browse catalog</Button>
    <Button size="small" variant="secondary" onclick={() => void importTheme()}>Import file</Button>
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
      aria-label="Install an official theme"
      placeholder="Choose an official theme"
      items={[
        { value: '', label: 'Choose an official theme' },
        ...catalog.map((theme) => ({ value: theme.fullUrl, label: theme.basename })),
      ]}
      onValueChange={() => void installCatalog()}
    />
  {/if}
  {#if error}<p class="error" role="alert">{error}</p>{/if}
  {#if customThemes.themes.length > 0}
    <div class="theme-slots">
      {#each themeKinds as kind (kind)}
        <label>
          {kind === 'light' ? 'Light theme' : 'Dark theme'}
          <Select
            value={selectedCustomThemeId(kind) ?? ''}
            placeholder="Built-in"
            items={[
              { value: '', label: 'Built-in' },
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
    color: var(--sable-surface-var-on-container);
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

  .error {
    color: var(--sable-crit-main);
  }
</style>
