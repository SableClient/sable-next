<script lang="ts">
  import { i18n } from '#lib/i18n.js';
  import {
    customThemes,
    installCustomTheme,
    installCustomTweak,
  } from '#lib/settings/custom-themes.svelte.js';
  import {
    parseThemeFile,
    themeFileBaseName,
    themeSwatches,
    type ThemeFile,
  } from '#lib/settings/theme-file.js';
  import Button from '#lib/ui/primitives/Button.svelte';
  import ConfirmDialog from '#lib/ui/primitives/ConfirmDialog.svelte';
  import ThemeSwatches from '#lib/ui/ThemeSwatches.svelte';

  interface Props {
    src: string;
    name: string;
  }

  let { src, name }: Props = $props();

  let file = $state.raw<ThemeFile | null>(null);
  let confirming = $state(false);
  let swatches = $state.raw<string[]>([]);

  $effect(() => {
    let current = true;
    const fallback = themeFileBaseName(name);
    void fetch(src)
      .then((response) => response.text())
      .then((css) => {
        if (!current) return;
        const parsed = parseThemeFile(css, fallback);
        file = typeof parsed === 'string' ? null : parsed;
        swatches = typeof parsed === 'string' ? [] : themeSwatches(css);
      })
      .catch((error: unknown) => {
        console.debug('[sable themes] theme attachment unreadable', error);
      });
    return () => {
      current = false;
    };
  });

  let installed = $derived.by(() => {
    if (file === null) return false;
    const css = file.kind === 'theme' ? file.theme.css : file.tweak.css;
    const list = file.kind === 'theme' ? customThemes.themes : customThemes.tweaks;
    return list.some((entry) => entry.css === css);
  });

  let title = $derived(
    file === null ? '' : file.kind === 'theme' ? file.theme.name : file.tweak.name
  );
  let kindLabel = $derived(
    file === null
      ? ''
      : file.kind === 'tweak'
        ? $i18n.t('settings.themeFileTweak')
        : file.theme.kind === 'dark'
          ? $i18n.t('settings.customThemesDarkTheme')
          : $i18n.t('settings.customThemesLightTheme')
  );

  function install(): void {
    confirming = false;
    if (file === null) return;
    if (file.kind === 'theme') installCustomTheme(file.theme);
    else installCustomTweak(file.tweak);
  }
</script>

{#if file}
  <div class="theme-file-card">
    <ThemeSwatches colors={swatches} />
    <span class="theme-file-identity">
      <span class="theme-file-name">{title}</span>
      <span class="theme-file-kind">{kindLabel}</span>
    </span>
    <Button
      size="small"
      variant="secondary"
      disabled={installed}
      onclick={() => (confirming = true)}
    >
      {installed ? $i18n.t('settings.themeFileInstalled') : $i18n.t('settings.themeFileInstall')}
    </Button>
  </div>
  <ConfirmDialog
    bind:open={confirming}
    title={$i18n.t('settings.themeFileConfirmTitle', { name: title })}
    description={$i18n.t('settings.themeFileConfirmHint')}
    confirmLabel={$i18n.t('settings.themeFileInstall')}
    confirmVariant="primary"
    onConfirm={install}
  />
{/if}

<style>
  .theme-file-card {
    align-items: center;
    background: var(--surface-var-container);
    border: var(--border-width) solid var(--surface-container-line);
    border-radius: var(--radius);
    display: flex;
    gap: var(--space-300);
    margin-top: var(--space-200);
    max-width: 24rem;
    padding: var(--space-200) var(--space-300);
  }

  .theme-file-identity {
    display: grid;
    flex: 1;
    min-width: 0;
  }

  .theme-file-name {
    font-weight: var(--font-weight-medium);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .theme-file-kind {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
  }
</style>
