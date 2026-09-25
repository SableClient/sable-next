<script lang="ts">
  import { i18n } from '#lib/i18n.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import Select from '#lib/ui/primitives/Select.svelte';
  import Slider from '#lib/ui/primitives/Slider.svelte';
  import SettingsSection from '#lib/ui/primitives/SettingsSection.svelte';
  import { panelsFor } from './category-panels.js';
  import Switch from '#lib/ui/primitives/Switch.svelte';
  import SettingsRow from '#lib/ui/primitives/SettingsRow.svelte';
  import { settingFocusId } from '#lib/settings/registry.js';
  import type { SettingDefinition, SettingsCategory } from '#lib/settings/registry.js';
  import {
    PREFERENCE_RANGES,
    preferences,
    setPreference,
  } from '#lib/settings/preferences.svelte.js';
  import type { Preferences } from '#lib/settings/preferences.svelte.js';

  interface Props {
    category: SettingsCategory;
  }

  let { category }: Props = $props();

  const items = $derived(category.items.filter((setting) => setting.supported?.() !== false));

  const shown = $derived(new Set(items.map((setting) => setting.key)));

  const panels = $derived(panelsFor(category.id).filter((panel) => panel.when?.() !== false));
  const sections = $derived(
    category.sections
      .map((section) => ({
        section,
        rows: items.filter((setting) => setting.section === section.id),
        panels: panels.filter((panel) => panel.section === section.id),
      }))
      .filter(({ rows, panels }) => rows.length > 0 || panels.length > 0)
  );
  const loosePanels = $derived(panels.filter((panel) => panel.section === undefined));

  /** A gate this platform never renders would disable its dependants forever. */
  function gated(setting: SettingDefinition): boolean {
    return (
      setting.gatedBy !== undefined && shown.has(setting.gatedBy) && !preferences[setting.gatedBy]
    );
  }

  function gateName(setting: SettingDefinition): string {
    return items.find((item) => item.key === setting.gatedBy)?.name ?? '';
  }

  /** Sentry reads its consent once, at boot. */
  let reloadPending = $state(false);
</script>

{#snippet settingRows(rows: SettingDefinition[])}
  <ul class="settings">
    {#each rows as setting (setting.key)}
      {@const gate = gated(setting)}
      {@const disabled = setting.unavailable === true || gate}
      {@const anchor = settingFocusId(setting.key)}
      <SettingsRow
        id={anchor}
        data-settings-focus={anchor}
        title={$i18n.t(setting.name)}
        description={setting.description ? $i18n.t(setting.description) : undefined}
        {disabled}
        badge={setting.unavailable
          ? $i18n.t('settings.notAvailableYet')
          : gate
            ? $i18n.t('settings.needsSetting', { name: $i18n.t(gateName(setting)) })
            : undefined}
        wide={setting.type !== 'boolean'}
        control={setting.type === 'boolean' && !disabled ? `${anchor}-switch` : undefined}
        class={setting.gatedBy !== undefined ? 'gated' : undefined}
      >
        {#if setting.type === 'select'}
          {@const key = setting.key}
          <Select
            {disabled}
            aria-label={$i18n.t(setting.name)}
            value={preferences[key]}
            items={setting.options.map((option) => ({
              value: option.value,
              label: option.literal ? option.label : $i18n.t(option.label),
              labelClass: option.literal ? 'literal-label' : undefined,
            }))}
            onValueChange={(value) => {
              setPreference(key, value as Preferences[typeof key]);
              setting.onChange?.(value);
            }}
          />
        {:else if setting.type === 'range'}
          {@const key = setting.key}
          <div class="range">
            <Slider
              {disabled}
              min={PREFERENCE_RANGES[key].min}
              max={PREFERENCE_RANGES[key].max}
              step={setting.step}
              label={$i18n.t(setting.name)}
              value={preferences[key]}
              oninput={(value) => {
                if (!setting.applyOnCommit) setPreference(key, value);
              }}
              oncommit={(value) => {
                if (setting.applyOnCommit) setPreference(key, value);
                setting.onChange?.(value);
              }}
            />
            <span class="range-reading">{Math.round(preferences[key] * 100)}%</span>
          </div>
        {:else}
          {@const key = setting.key}
          <Switch
            id={`${anchor}-switch`}
            {disabled}
            label={$i18n.t(setting.name)}
            checked={gate ? false : preferences[key]}
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
{/snippet}

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

  {#each sections as { section, rows, panels: sectionPanels } (section.id)}
    <SettingsSection title={$i18n.t(section.name)} headingId={section.id}>
      {#each sectionPanels.filter((panel) => panel.start) as panel (panel.component)}
        <panel.component />
      {/each}
      {#if rows.length > 0}{@render settingRows(rows)}{/if}
      {#each sectionPanels.filter((panel) => !panel.start) as panel (panel.component)}
        <panel.component />
      {/each}
    </SettingsSection>
  {/each}

  {#each loosePanels as panel (panel.component)}
    <section class="settings-card"><panel.component /></section>
  {/each}
</div>

<style>
  .range {
    align-items: center;
    display: flex;
    gap: var(--space-150);
    width: 100%;
  }

  .range-reading {
    flex: none;
    font-size: var(--font-size-small);
    font-variant-numeric: tabular-nums;
    inline-size: 2.5rem;
    text-align: end;
  }

  .settings-stack {
    display: grid;
    gap: var(--space-300);
  }

  .settings-card {
    background: var(--bg-container);
    border-radius: var(--radius);
    overflow: hidden;
  }

  .settings {
    list-style: none;
    margin: 0;
    padding: 0;
  }
</style>
