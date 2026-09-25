<script lang="ts">
  import TrashIcon from 'phosphor-svelte/lib/TrashIcon';
  import { onDestroy, tick, untrack } from 'svelte';
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
    type CustomTweak,
  } from '#lib/settings/custom-themes.svelte.js';
  import { preferences } from '#lib/settings/preferences.svelte.js';
  import { resolveTheme, type ResolvedTheme } from '#lib/settings/theme.js';
  import {
    DEFAULT_THEME_SWATCHES,
    isThemeFileName,
    parseThemeFile,
    themeFileBaseName,
    themeFileMetadata,
    themeRadius,
    themeSwatches,
  } from '#lib/settings/theme-file.js';
  import { pickFiles } from '#lib/platform/files.js';
  import { i18n, t } from '#lib/i18n.js';
  import { toasts } from '#lib/ui/toasts.svelte.js';
  import Button from '#lib/ui/primitives/Button.svelte';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import StatusBadge from '#lib/ui/primitives/StatusBadge.svelte';
  import Switch from '#lib/ui/primitives/Switch.svelte';
  import '#lib/ui/primitives/settings-row.css';

  import ThemeCatalog from './ThemeCatalog.svelte';
  import ThemeTile from './ThemeTile.svelte';
  import { fetchCatalogFile, type CatalogEntry } from './theme-catalog';

  const SLOTS: readonly ResolvedTheme[] = ['light', 'dark'];
  const STEPS: Partial<Record<string, number>> = {
    ArrowRight: 1,
    ArrowDown: 1,
    ArrowLeft: -1,
    ArrowUp: -1,
  };
  const systemDark = new MediaQuery('(prefers-color-scheme: dark)');

  let catalogOpen = $state(false);
  let installing = $state<string | null>(null);
  let error = $state<string | null>(null);
  let failed = $state<string | null>(null);
  let picker = $state<HTMLInputElement>();

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

  function install(css: string, fallback: string, source?: string, activate = false): boolean {
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
    installCustomTheme(theme, activate);
    offerUndo(
      activate
        ? t('settings.themeSetFor', { name: theme.name, mode: slotLabel(theme.kind).toLowerCase() })
        : t('settings.themeInstalled', { name: theme.name }),
      () => {
        removeCustomTheme(theme.id);
        const restorable =
          previous === null || customThemes.themes.some((item) => item.id === previous);
        if (activate && restorable && selectedCustomThemeId(theme.kind) === null) {
          selectCustomTheme(theme.kind, previous);
        }
      }
    );
    return true;
  }

  async function tryFromCatalog(entry: CatalogEntry): Promise<void> {
    if (entry.kind !== 'theme') return;
    previewing = entry.fullUrl;
    failed = null;
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
      failed = entry.fullUrl;
    } finally {
      previewing = null;
    }
  }

  function keepPreview(): void {
    const preview = themePreview.current;
    if (!preview) return;
    clearThemePreview();
    install(preview.css, preview.name, preview.source, true);
  }

  $effect(() => {
    if (catalogOpen) return;
    untrack(clearThemePreview);
    failed = null;
  });

  onDestroy(clearThemePreview);

  async function installFromCatalog(entry: CatalogEntry): Promise<void> {
    installing = entry.fullUrl;
    failed = null;
    try {
      if (themePreview.current?.source === entry.fullUrl) clearThemePreview();
      const css = await fetchCatalogFile(entry.fullUrl);
      if (!install(css, entry.basename, entry.fullUrl, false)) throw new Error('unreadable');
    } catch {
      error = null;
      failed = entry.fullUrl;
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

  function openCatalog(): void {
    catalogOpen = true;
  }

  function themesForSlot(slot: ResolvedTheme): CustomTheme[] {
    const selected = selectedCustomThemeId(slot);
    return customThemes.themes.filter((theme) => theme.kind === slot || theme.id === selected);
  }

  function revealSelected(list: HTMLElement): void {
    const tile = list.querySelector('[aria-checked="true"]')?.closest('li');
    if (!tile) return;
    list.scrollTop += tile.getBoundingClientRect().top - list.getBoundingClientRect().top;
  }

  async function moveInSlot(event: KeyboardEvent, slot: ResolvedTheme): Promise<void> {
    const list = event.currentTarget as HTMLElement;
    const radios = [...list.querySelectorAll<HTMLElement>('[role="radio"]')];
    const from = radios.findIndex((radio) => radio === document.activeElement);
    if (from < 0) return;
    const ids = [null, ...themesForSlot(slot).map((theme) => theme.id)];
    const last = ids.length - 1;
    if (event.key === 'Delete' || event.key === 'Backspace') {
      const theme = customThemes.themes.find((item) => item.id === ids[from]);
      if (!theme) return;
      event.preventDefault();
      removeTheme(theme);
      await tick();
      list.querySelectorAll<HTMLElement>('[role="radio"]')[from - 1]?.focus();
      return;
    }
    const step = STEPS[event.key];
    const to =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? last
          : step === undefined
            ? null
            : (from + step + ids.length) % ids.length;
    if (to === null) return;
    event.preventDefault();
    selectCustomTheme(slot, ids[to] ?? null);
    await tick();
    list.querySelectorAll<HTMLElement>('[role="radio"]')[to]?.focus();
  }

  function use(theme: CustomTheme, slot: ResolvedTheme): void {
    selectCustomTheme(slot, theme.id);
  }

  function removeTheme(theme: CustomTheme): void {
    const slots = SLOTS.filter((slot) => selectedCustomThemeId(slot) === theme.id);
    removeCustomTheme(theme.id);
    offerUndo(t('settings.themeRemoved', { name: theme.name }), () => {
      installCustomTheme(theme, false);
      for (const slot of slots) {
        if (selectedCustomThemeId(slot) === null) selectCustomTheme(slot, theme.id);
      }
    });
  }

  function removeTweak(tweak: CustomTweak): void {
    const enabled = customThemes.enabledTweakIds.includes(tweak.id);
    removeCustomTweak(tweak.id);
    offerUndo(t('settings.themeRemoved', { name: tweak.name }), () => {
      installCustomTweak(tweak);
      if (!enabled) enableCustomTweak(tweak.id, false);
    });
  }
</script>

<div class="custom-themes settings-form">
  <p class="themes-hint">{$i18n.t('settings.customThemesSlotsHint')}</p>

  {#each SLOTS as slot (slot)}
    {@const themes = themesForSlot(slot)}
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
      <ul
        class="tiles"
        role="radiogroup"
        id={`theme-slot-${slot}-items`}
        aria-labelledby={`theme-slot-${slot}`}
        onkeydown={(event) => void moveInSlot(event, slot)}
        {@attach revealSelected}
      >
        <li role="none">
          <ThemeTile
            name={$i18n.t('settings.themeSableDefault')}
            swatches={DEFAULT_THEME_SWATCHES[slot]}
            selected={selected === null}
            tabindex={selected === null ? 0 : -1}
            onselect={() => {
              selectCustomTheme(slot, null);
            }}
          />
        </li>
        {#each themes as theme (theme.id)}
          <li role="none">
            <ThemeTile
              name={theme.name}
              swatches={themeSwatches(theme.css)}
              radius={themeRadius(theme.css)}
              innerRadius={themeRadius(theme.css, 'radius-inner')}
              selected={selected === theme.id}
              tabindex={selected === theme.id ? 0 : -1}
              keyshortcuts="Delete"
              onselect={() => {
                use(theme, slot);
              }}
            >
              {#snippet trailing()}
                <IconButton
                  variant="ghost"
                  size="small"
                  tabindex={-1}
                  label={$i18n.t('settings.customThemesRemove', { name: theme.name })}
                  onclick={() => {
                    removeTheme(theme);
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
      aria-expanded={catalogOpen}
      onclick={openCatalog}
    >
      {$i18n.t('settings.themeCatalogTitle')}
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

  {#if customThemes.tweaks.length > 0}
    <div class="tweaks-block">
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
                removeTweak(tweak);
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
    </div>
  {/if}
</div>

{#if catalogOpen}
  <ThemeCatalog
    bind:open={catalogOpen}
    {installing}
    {previewing}
    failedEntry={failed}
    preview={themePreview.current}
    oninstall={(entry) => void installFromCatalog(entry)}
    onpreview={(entry) => void tryFromCatalog(entry)}
    onkeep={keepPreview}
    onrevert={clearThemePreview}
  />
{/if}

<style>
  .custom-themes {
    display: grid;
    gap: var(--space-400);
  }

  p {
    margin: 0;
  }

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
    margin-inline: calc(var(--space-100) * -1);
    max-block-size: min(30rem, 54dvh);
    overflow-y: auto;
    padding: var(--space-100);
    scrollbar-gutter: stable;
  }

  @media (width < 36rem) {
    .tiles {
      gap: var(--space-300);
    }
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
