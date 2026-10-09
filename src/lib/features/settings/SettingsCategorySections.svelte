<script lang="ts">
  import { i18n } from '#lib/i18n.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import '#lib/ui/primitives/form-control.css';
  import '#lib/ui/primitives/settings-row.css';
  import Select from '#lib/ui/primitives/Select.svelte';
  import Slider from '#lib/ui/primitives/Slider.svelte';
  import SettingsSection from '#lib/ui/primitives/SettingsSection.svelte';
  import { panelsFor } from './category-panels.js';
  import Switch from '#lib/ui/primitives/Switch.svelte';
  import SettingsRow from '#lib/ui/primitives/SettingsRow.svelte';
  import { settingFocusId, settingsCategories } from '#lib/settings/registry.js';
  import type { SettingDefinition, SettingsCategory } from '#lib/settings/registry.js';
  import {
    PREFERENCE_RANGES,
    preferences,
    setPreference,
  } from '#lib/settings/preferences.svelte.js';
  import type { Preferences } from '#lib/settings/preferences.svelte.js';

  interface Props {
    category: SettingsCategory;
    onRangeDraft?: (key: string, value: number | null) => void;
  }

  let { category, onRangeDraft }: Props = $props();

  const items = $derived(
    category.items.filter((setting) => setting.supported?.() !== false && setting.panel !== true)
  );

  const supportedSettings = $derived(
    settingsCategories.flatMap((entry) =>
      entry.items.filter((setting) => setting.supported?.() !== false)
    )
  );
  const shown = $derived(new Set(supportedSettings.map((setting) => setting.key)));

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
    return supportedSettings.find((item) => item.key === setting.gatedBy)?.name ?? '';
  }

  /** Sentry reads its consent once, at boot. */
  let reloadPending = $state(false);
</script>

{#snippet settingRows(rows: SettingDefinition[])}
  <ul class="settings settings-rows">
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
            forceDropdown={setting.key === 'profileChangePropagation'}
            aria-label={$i18n.t(setting.name)}
            value={setting.getValue?.() ?? preferences[key]}
            items={setting.options.map((option) => ({
              value: option.value,
              label: option.literal ? option.label : $i18n.t(option.label),
              labelClass: option.literal ? 'literal-label' : undefined,
            }))}
            onValueChange={(value) => {
              if (setting.setValue) setting.setValue(value);
              else setPreference(key, value as Preferences[typeof key]);
              setting.onChange?.(value);
            }}
          />
        {:else if setting.type === 'range'}
          {@const key = setting.key}
          <div class="range">
            <Slider
              {disabled}
              requireThumbForTouch
              min={PREFERENCE_RANGES[key].min}
              max={PREFERENCE_RANGES[key].max}
              step={setting.step}
              label={$i18n.t(setting.name)}
              value={preferences[key]}
              oninput={(value) => {
                if (setting.applyOnCommit) onRangeDraft?.(key, value);
                else setPreference(key, value);
              }}
              oncommit={(value) => {
                onRangeDraft?.(key, null);
                if (setting.applyOnCommit) setPreference(key, value);
                setting.onChange?.(value);
              }}
            />
            <label class="form-control range-reading">
              <input
                class="range-input"
                type="number"
                inputmode="numeric"
                {disabled}
                min={Math.round(PREFERENCE_RANGES[key].min * 100)}
                max={Math.round(PREFERENCE_RANGES[key].max * 100)}
                step={Math.round(setting.step * 100)}
                value={Math.round(preferences[key] * 100)}
                aria-label={$i18n.t('settings.rangePercent', { name: $i18n.t(setting.name) })}
                onchange={(event) => {
                  const typed = Number(event.currentTarget.value) / 100;
                  if (event.currentTarget.value !== '' && Number.isFinite(typed)) {
                    const { min, max } = PREFERENCE_RANGES[key];
                    const next = Math.min(max, Math.max(min, typed));
                    setPreference(key, next);
                    setting.onChange?.(next);
                  }
                  event.currentTarget.value = String(Math.round(preferences[key] * 100));
                }}
              /><span class="range-suffix" aria-hidden="true">%</span>
            </label>
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
        {$i18n.t('common.reload')}
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
  .settings-stack {
    display: grid;
    gap: var(--space-300);
    grid-template-columns: minmax(0, 1fr);
  }

  .settings-card {
    background: var(--bg-container);
    border-radius: var(--radius);
    color: var(--bg-on-container);
    overflow: hidden;
  }
</style>
