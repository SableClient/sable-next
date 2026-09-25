<script lang="ts">
  import TrashIcon from 'phosphor-svelte/lib/TrashIcon';
  import { onDestroy, untrack } from 'svelte';
  import { MediaQuery } from 'svelte/reactivity';

  import {
    customThemes,
    enableCustomTweak,
    installCustomTheme,
    installCustomTweak,
    removeCustomTheme,
    removeCustomTweak,
    clearThemePreview,
    previewTheme,
    selectCustomTheme,
    selectedCustomThemeId,
    themePreview,
    type CustomTheme,
  } from '#lib/settings/custom-themes.svelte.js';
  import { preferences } from '#lib/settings/preferences.svelte.js';
  import { resolveTheme, type ResolvedTheme } from '#lib/settings/theme.js';
  import {
    DEFAULT_THEME_SWATCHES,
    isThemeFileName,
    parseThemeFile,
    themeFileBaseName,
    themeFileMetadata,
    themeSwatches,
  } from '#lib/settings/theme-file.js';
  import { pickFiles } from '#lib/platform/files.js';
  import { i18n, t } from '#lib/i18n.js';
  import { toasts } from '#lib/ui/toasts.svelte.js';
  import Button from '#lib/ui/primitives/Button.svelte';
  import ConfirmDialog from '#lib/ui/primitives/ConfirmDialog.svelte';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import SettingsAnchorLink from '#lib/ui/primitives/SettingsAnchorLink.svelte';
  import StatusBadge from '#lib/ui/primitives/StatusBadge.svelte';
  import Switch from '#lib/ui/primitives/Switch.svelte';
  import '#lib/ui/primitives/settings-row.css';

  import ThemeCatalog from './ThemeCatalog.svelte';
  import ThemeTile from './ThemeTile.svelte';
  import { entryName, fetchCatalogFile, type CatalogEntry } from './theme-catalog';

  const SLOTS: readonly ResolvedTheme[] = ['light', 'dark'];
  const systemDark = new MediaQuery('(prefers-color-scheme: dark)');

  let catalogOpen = $state(false);
  let catalogTab = $state<'theme' | 'tweak'>('theme');
  let installing = $state<string | null>(null);
  let error = $state<string | null>(null);
  let picker = $state<HTMLInputElement>();
  let pendingRemoval = $state.raw<{ kind: 'theme' | 'tweak'; id: string; name: string } | null>(
    null
  );

  let showing = $derived(resolveTheme(preferences.theme, systemDark.current));
  let tweaksInert = $derived(selectedCustomThemeId(showing) === null);
  let previewing = $state<string | null>(null);

  let pendingReverts: Array<() => void> = [];
  let pendingToast: number | null = null;

  function slotLabel(kind: ResolvedTheme): string {
    return kind === 'light'
      ? $i18n.t('settings.customThemesLightSlot')
      : $i18n.t('settings.customThemesDarkSlot');
  }

  function settleUndo(): void {
    if (pendingToast !== null) toasts.dismiss(pendingToast);
  }

  function offerUndo(message: string, revert: () => void): void {
    const carried = pendingReverts;
    if (pendingToast !== null) {
      const previous = pendingToast;
      pendingToast = null;
      toasts.dismiss(previous);
    }
    pendingReverts = [...carried, revert];
    const count = pendingReverts.length;
    const id = toasts.undoable(count > 1 ? t('settings.themeChanges', { count }) : message, {
      label: t('settings.undo'),
      onUndo: () => {
        const reverts = pendingReverts;
        pendingReverts = [];
        pendingToast = null;
        for (const revert of reverts.slice().reverse()) revert();
      },
      onClose: () => {
        if (pendingToast !== id) return;
        pendingToast = null;
        pendingReverts = [];
      },
    });
    pendingToast = id;
  }

  function install(css: string, fallback: string, source?: string): boolean {
    const parsed = parseThemeFile(css, fallback);
    if (parsed === 'size') {
      error = $i18n.t('settings.customThemesErrorSize');
      return false;
    }
    if (parsed === 'header') {
      error = $i18n.t('settings.customThemesErrorHeader');
      return false;
    }
    if (parsed.kind === 'tweak') {
      const tweak = { ...parsed.tweak, source };
      installCustomTweak(tweak);
      offerUndo(t('settings.themeInstalled', { name: tweak.name }), () => {
        removeCustomTweak(tweak.id);
      });
      return true;
    }
    const theme = { ...parsed.theme, source };
    const previous = selectedCustomThemeId(theme.kind);
    installCustomTheme(theme);
    offerUndo(
      t('settings.themeSetFor', { name: theme.name, mode: slotLabel(theme.kind).toLowerCase() }),
      () => {
        removeCustomTheme(theme.id);
        const restorable =
          previous === null || customThemes.themes.some((item) => item.id === previous);
        if (restorable && selectedCustomThemeId(theme.kind) === null) {
          selectCustomTheme(theme.kind, previous);
        }
      }
    );
    return true;
  }

  async function tryFromCatalog(entry: CatalogEntry): Promise<void> {
    if (entry.kind !== 'theme') return;
    previewing = entry.fullUrl;
    error = null;
    try {
      const css = await fetchCatalogFile(entry.fullUrl);
      const parsed = parseThemeFile(css, entry.basename);
      if (typeof parsed === 'string' || parsed.kind !== 'theme') throw new Error(String(parsed));
      previewTheme({
        source: entry.fullUrl,
        name: parsed.theme.name,
        kind: parsed.theme.kind,
        css,
      });
    } catch {
      error = $i18n.t('settings.customThemesErrorInstall', { file: entryName(entry) });
    } finally {
      previewing = null;
    }
  }

  function keepPreview(): void {
    const preview = themePreview.current;
    if (!preview) return;
    clearThemePreview();
    install(preview.css, preview.name, preview.source);
  }

  $effect(() => {
    if (!catalogOpen) untrack(clearThemePreview);
  });

  onDestroy(clearThemePreview);

  async function installFromCatalog(entry: CatalogEntry): Promise<void> {
    installing = entry.fullUrl;
    error = null;
    try {
      if (themePreview.current?.source === entry.fullUrl) clearThemePreview();
      install(await fetchCatalogFile(entry.fullUrl), entry.basename, entry.fullUrl);
    } catch {
      error = $i18n.t('settings.customThemesErrorInstall', { file: entryName(entry) });
    } finally {
      installing = null;
    }
  }

  async function importFiles(files: FileList | File[]): Promise<void> {
    error = null;
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

  function openCatalog(tab: 'theme' | 'tweak'): void {
    catalogTab = tab;
    catalogOpen = true;
  }

  function use(theme: CustomTheme): void {
    selectCustomTheme(theme.kind, theme.id);
  }

  function askRemoval(kind: 'theme' | 'tweak', id: string, name: string): void {
    settleUndo();
    pendingRemoval = { kind, id, name };
  }

  function confirmRemoval(): void {
    if (pendingRemoval?.kind === 'theme') removeCustomTheme(pendingRemoval.id);
    else if (pendingRemoval?.kind === 'tweak') removeCustomTweak(pendingRemoval.id);
    pendingRemoval = null;
  }
</script>

<div class="custom-themes settings-form">
  <p class="themes-hint">{$i18n.t('settings.customThemesSlotsHint')}</p>

  {#each SLOTS as slot (slot)}
    {@const themes = customThemes.themes.filter((theme) => theme.kind === slot)}
    {@const selected = selectedCustomThemeId(slot)}
    {@const slotName =
      slot === 'light'
        ? $i18n.t('settings.customThemesLightSlot')
        : $i18n.t('settings.customThemesDarkSlot')}
    <div class="slot">
      <div class="slot-head">
        <span class="slot-name" id={`theme-slot-${slot}`}>{slotName}</span>
        {#if showing === slot}
          <StatusBadge variant="primary" label={$i18n.t('settings.themeShowingNow')} />
        {/if}
      </div>
      <ul class="tiles" role="radiogroup" aria-labelledby={`theme-slot-${slot}`}>
        <li>
          <ThemeTile
            name={$i18n.t('settings.themeSableDefault')}
            swatches={DEFAULT_THEME_SWATCHES[slot]}
            selected={selected === null}
            onselect={() => {
              selectCustomTheme(slot, null);
            }}
          />
        </li>
        {#each themes as theme (theme.id)}
          <li>
            <ThemeTile
              name={theme.name}
              swatches={themeSwatches(theme.css)}
              selected={selected === theme.id}
              onselect={() => {
                use(theme);
              }}
            >
              {#snippet actions()}
                <IconButton
                  variant="ghost"
                  size="small"
                  label={$i18n.t('settings.customThemesRemove', { name: theme.name })}
                  onclick={() => {
                    askRemoval('theme', theme.id, theme.name);
                  }}
                >
                  <TrashIcon />
                </IconButton>
              {/snippet}
            </ThemeTile>
          </li>
        {/each}
      </ul>
    </div>
  {/each}

  <div class="actions">
    <Button
      variant="primary"
      aria-haspopup="dialog"
      aria-expanded={catalogOpen && catalogTab === 'theme'}
      onclick={() => {
        openCatalog('theme');
      }}
    >
      {$i18n.t('settings.customThemesBrowse')}
    </Button>
    <Button variant="secondary" onclick={() => void importTheme()}>
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

  <section class="tweaks-block" aria-labelledby="custom-tweaks-title">
    <div class="settings-heading-row">
      <h3 id="custom-tweaks-title" data-settings-outline>{$i18n.t('settings.customTweaks')}</h3>
      <SettingsAnchorLink anchor="custom-tweaks-title" />
    </div>
    <p class="themes-hint">{$i18n.t('settings.themeCatalogTweaksHint')}</p>
    {#if customThemes.tweaks.length > 0}
      <ul class="tweaks">
        {#each customThemes.tweaks as tweak (tweak.id)}
          {@const description = themeFileMetadata(tweak.css).description}
          <li class="tweak" class:inert-tweak={tweaksInert}>
            <span class="tweak-copy">
              <span class="tweak-name">{tweak.name}</span>
              {#if description}<span class="tweak-detail">{description}</span>{/if}
              {#if tweaksInert}
                <span class="tweak-note">{$i18n.t('settings.tweakNeedsTheme')}</span>
              {/if}
            </span>
            <IconButton
              variant="ghost"
              size="small"
              label={$i18n.t('settings.customThemesRemove', { name: tweak.name })}
              onclick={() => {
                askRemoval('tweak', tweak.id, tweak.name);
              }}
            >
              <TrashIcon />
            </IconButton>
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
    <div class="actions">
      <Button
        variant="secondary"
        aria-haspopup="dialog"
        aria-expanded={catalogOpen && catalogTab === 'tweak'}
        onclick={() => {
          openCatalog('tweak');
        }}
      >
        {$i18n.t('settings.customThemesBrowseTweaks')}
      </Button>
    </div>
  </section>
</div>

{#if catalogOpen}
  <ThemeCatalog
    bind:open={catalogOpen}
    initialTab={catalogTab}
    {installing}
    {previewing}
    preview={themePreview.current}
    oninstall={(entry) => void installFromCatalog(entry)}
    onpreview={(entry) => void tryFromCatalog(entry)}
    onkeep={keepPreview}
    onrevert={clearThemePreview}
    onuse={use}
    onimport={() => void importTheme()}
  />
{/if}

{#if pendingRemoval !== null}
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
{/if}

<style>
  .custom-themes {
    display: grid;
    gap: var(--space-400);
  }

  h3,
  p {
    margin: 0;
  }

  h3,
  .slot-name {
    font-size: var(--font-size-label);
    font-weight: var(--font-weight-medium);
  }

  .themes-hint {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    max-width: 60ch;
  }

  .slot {
    display: grid;
    gap: var(--space-200);
  }

  .slot-head {
    align-items: center;
    display: flex;
    gap: var(--space-200);
  }

  .tiles {
    display: grid;
    gap: var(--space-400);
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 8.5rem), 1fr));
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-200);
  }

  .actions :global(.btn) {
    min-height: max(var(--control-height-400), var(--target-hit));
  }

  .tweaks-block {
    border-top: var(--border-width) solid var(--surface-container-line);
    display: grid;
    gap: var(--space-200);
    padding-top: var(--space-400);
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
  }

  .tweak + .tweak {
    border-top: var(--border-width) solid var(--surface-container-line);
  }

  .tweak-copy {
    display: grid;
    flex: 1;
    min-width: 0;
  }

  .tweak-note {
    color: var(--warn-on-container);
    font-size: var(--font-size-small);
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

  .inert-tweak .tweak-name,
  .inert-tweak .tweak-detail {
    opacity: 0.65;
  }

  .error {
    color: var(--crit-main);
    font-size: var(--font-size-small);
  }
</style>
