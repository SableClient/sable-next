<script lang="ts">
  import { page } from '$app/state';

  import { i18n } from '#lib/i18n.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import AppPageShell from '#lib/ui/primitives/AppPageShell.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import Select from '#lib/ui/primitives/Select.svelte';
  import SettingsSection from '#lib/ui/primitives/SettingsSection.svelte';
  import { panelsFor } from './category-panels.js';
  import Switch from '#lib/ui/primitives/Switch.svelte';
  import CheckIcon from 'phosphor-svelte/lib/CheckIcon';
  import LinkIcon from 'phosphor-svelte/lib/LinkIcon';

  import { buildSettingsLink } from '#lib/features/room/settings-link.js';
  import SettingsRow from '#lib/ui/primitives/SettingsRow.svelte';
  import { settingFocusId } from '#lib/settings/registry.js';
  import type { SettingDefinition, SettingsCategory } from '#lib/settings/registry.js';
  import { preferences, setPreference } from '#lib/settings/preferences.svelte.js';
  import type { Preferences } from '#lib/settings/preferences.svelte.js';

  interface Props {
    category: SettingsCategory;
  }

  let { category }: Props = $props();

  const items = $derived(category.items.filter((setting) => setting.supported?.() !== false));

  const shown = $derived(new Set(items.map((setting) => setting.key)));

  /** A gate this platform never renders would disable its dependants forever. */
  function gated(setting: SettingDefinition): boolean {
    return (
      setting.gatedBy !== undefined && shown.has(setting.gatedBy) && !preferences[setting.gatedBy]
    );
  }

  let focusId = $derived(page.url.searchParams.get('focus'));
  let highlighted = $state<string | null>(null);
  let copied = $state<string | null>(null);
  /** Sentry reads its consent once, at boot. */
  let reloadPending = $state(false);

  async function copyLink(anchor: string): Promise<void> {
    await navigator.clipboard.writeText(buildSettingsLink(location.origin, category.id, anchor));
    copied = anchor;
    setTimeout(() => {
      if (copied === anchor) copied = null;
    }, 2000);
  }

  $effect(() => {
    const id = focusId;
    if (id === null || !items.some((setting) => settingFocusId(setting.key) === id)) {
      return;
    }

    document.getElementById(id)?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    highlighted = id;
    const timer = setTimeout(() => {
      highlighted = null;
    }, 3000);
    return () => {
      clearTimeout(timer);
    };
  });
</script>

<AppPageShell
  title={$i18n.t(category.name)}
  description={category.description ? $i18n.t(category.description) : undefined}
  density="compact"
  class="settings-category"
>
  <div class="settings-stack">
    {#if reloadPending}
      <Alert variant="info">
        <p>{$i18n.t('settings.telemetryReloadNotice')}</p>
        <Button
          variant="secondary"
          size="small"
          onclick={() => {
            location.reload();
          }}
        >
          {$i18n.t('settings.telemetryReloadAction')}
        </Button>
      </Alert>
    {/if}

    <section class="settings-card" aria-labelledby={`settings-${category.id}`}>
      <h2 id={`settings-${category.id}`} class="screen-reader-only">{$i18n.t(category.name)}</h2>
      <ul class="settings">
        {#each items as setting (setting.key)}
          {@const disabled = setting.unavailable === true || gated(setting)}
          {@const anchor = settingFocusId(setting.key)}
          <SettingsRow
            id={anchor}
            data-settings-focus={anchor}
            title={$i18n.t(setting.name)}
            description={setting.description ? $i18n.t(setting.description) : undefined}
            icon={setting.icon}
            {disabled}
            badge={setting.unavailable ? $i18n.t('settings.notAvailableYet') : undefined}
            highlighted={highlighted === anchor}
            wide={setting.type === 'select'}
            class={setting.gatedBy !== undefined ? 'gated' : undefined}
            titleAction={{
              label: $i18n.t(copied === anchor ? 'settings.linkCopied' : 'settings.copyLink'),
              icon: copied === anchor ? CheckIcon : LinkIcon,
              onclick: () => void copyLink(anchor),
            }}
          >
            {#if setting.type === 'select'}
              {@const key = setting.key}
              <Select
                {disabled}
                aria-label={$i18n.t(setting.name)}
                value={preferences[key]}
                items={setting.options.map((option) => ({
                  value: option.value,
                  label: $i18n.t(option.label),
                }))}
                onValueChange={(value) => {
                  setPreference(key, value as Preferences[typeof key]);
                }}
              />
            {:else}
              {@const key = setting.key}
              <Switch
                {disabled}
                label={$i18n.t(setting.name)}
                checked={preferences[key]}
                onCheckedChange={(checked: boolean) => {
                  setPreference(key, checked);
                  setting.onChange?.(checked);
                  if (setting.requiresReload) reloadPending = true;
                }}
              />
            {/if}
          </SettingsRow>
        {/each}
      </ul>
    </section>

    {#each panelsFor(category.id) as panel (panel.component)}
      {#if !panel.when || panel.when()}
        {#if panel.title}
          <SettingsSection
            title={$i18n.t(panel.title)}
            headingId={panel.headingId}
            class={panel.class}
          >
            <panel.component />
          </SettingsSection>
        {:else}
          <section class={['settings-card', panel.class]}><panel.component /></section>
        {/if}
      {/if}
    {/each}
  </div>
</AppPageShell>

<style>
  :global(.app-page-shell.settings-category) {
    max-width: 56rem;
  }

  .settings-stack {
    display: grid;
    gap: var(--space-2);
  }

  .settings-card {
    background: var(--sable-bg-container);
    border-radius: var(--radius);
    overflow: hidden;
  }

  .custom-themes-card,
  .personas-card {
    padding: var(--space-3);
  }

  .settings {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  :global(.state-event-section .settings-section-content) {
    padding: var(--space-3);
  }
</style>
