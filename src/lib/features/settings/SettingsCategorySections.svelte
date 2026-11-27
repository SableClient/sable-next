<script lang="ts">
  import { clamp } from '#lib/clamp.js';
  import { useCoreClient } from '#lib/core/context.js';
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
  import {
    settingFocusId,
    settingShown,
    settingsCategories,
    settingsContext,
    settingsTargets,
  } from '#lib/settings/registry.js';
  import type {
    SettingDefinition,
    SettingsCategory,
    SettingsSectionDefinition,
  } from '#lib/settings/registry.js';
  import { SvelteSet } from 'svelte/reactivity';
  import type { CategoryPanel } from './category-panels.js';
  import {
    isLockedPreference,
    preferences,
    setPreference,
  } from '#lib/settings/preferences.svelte.js';
  import { PREFERENCE_RANGES } from '#lib/settings/definitions.js';
  import type { Preferences } from '#lib/settings/definitions.js';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';
  import { rovingFocus } from '#lib/ui/roving-focus.js';

  interface Props {
    category: SettingsCategory;
    focus?: string | null;
    onRangeDraft?: (key: string, value: number | null) => void;
  }

  let { category, focus = null, onRangeDraft }: Props = $props();

  const core = useCoreClient();
  const context = $derived(settingsContext(core));

  const items = $derived(
    category.items.filter(
      (setting) =>
        setting.supported?.(context) !== false &&
        setting.panel === undefined &&
        settingShown(setting, preferences)
    )
  );

  const supportedSettings = $derived(
    settingsCategories.flatMap((entry) =>
      entry.items.filter((setting) => setting.supported?.(context) !== false)
    )
  );
  const shown = $derived(new Set(supportedSettings.map((setting) => setting.key)));

  const panels = $derived(panelsFor(category.id, context));
  const sections = $derived(
    category.sections
      .map((section) => ({
        section,
        rows: items.filter((setting) => setting.section === section.id),
        panels: panels.filter((panel) => panel.section === section.id),
      }))
      .filter(({ rows, panels }) => rows.length > 0 || panels.length > 0)
  );
  const tabs = $derived(
    (category.tabs ?? []).filter((tab) => sections.some((entry) => tabOf(entry.section) === tab.id))
  );
  let chosenTab = $derived(focusedTab(focus));
  const activeTab = $derived(tabs.find((tab) => tab.id === chosenTab)?.id ?? tabs[0]?.id ?? null);
  /** A visited tab stays mounted so its panels keep what they loaded. */
  const visited = new SvelteSet<string>();

  function selectTab(id: string): void {
    if (activeTab !== null) visited.add(activeTab);
    visited.add(id);
    chosenTab = id;
  }

  function tabOf(section: { tab?: string }): string | undefined {
    return section.tab ?? category.tabs?.[0]?.id;
  }

  function focusedTab(id: string | null): string | null {
    if (id === null || !category.tabs) return null;
    const sectionId =
      settingsTargets(category).find(
        (target) => (target.focusId ?? settingFocusId(target.key)) === id
      )?.section ?? id;
    const section = category.sections.find((entry) => entry.id === sectionId);
    return section ? (tabOf(section) ?? null) : null;
  }
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

  let serverFeatures = $state.raw<readonly string[] | null>(null);
  const needsServerFeatures = $derived(items.some((setting) => setting.serverFeature));

  $effect(() => {
    if (!needsServerFeatures) return;
    let stale = false;
    core.rpc.session
      .serverFeatures()
      .then((flags) => {
        if (!stale) serverFeatures = flags;
      })
      .catch((error: unknown) => {
        console.warn('[sable settings] server features unavailable', error);
      });
    return () => {
      stale = true;
    };
  });

  function missingServerFeature(setting: SettingDefinition): boolean {
    return (
      setting.serverFeature !== undefined &&
      serverFeatures !== null &&
      !serverFeatures.includes(setting.serverFeature)
    );
  }

  /** Sentry reads its consent once, at boot. */
  let reloadPending = $state(false);
</script>

{#snippet sectionBlock({
  section,
  rows,
  panels: sectionPanels,
}: {
  section: SettingsSectionDefinition;
  rows: SettingDefinition[];
  panels: CategoryPanel[];
})}
  <SettingsSection title={i18n.t(section.name)} headingId={section.id}>
    {#each sectionPanels.filter((panel) => panel.start) as panel (panel.component)}
      <panel.component />
    {/each}
    {#if rows.length > 0}{@render settingRows(rows)}{/if}
    {#each sectionPanels.filter((panel) => !panel.start) as panel (panel.component)}
      <panel.component />
    {/each}
  </SettingsSection>
{/snippet}

{#snippet settingRows(rows: SettingDefinition[])}
  <ul class="settings settings-rows">
    {#each rows as setting (setting.key)}
      {@const gate = gated(setting)}
      {@const unsupported = missingServerFeature(setting)}
      {@const lockedByDeployment = isLockedPreference(setting.key)}
      {@const disabled = setting.unavailable === true || gate || unsupported || lockedByDeployment}
      {@const anchor = settingFocusId(setting.key)}
      <SettingsRow
        id={anchor}
        key={setting.key}
        data-settings-focus={anchor}
        title={i18n.t(setting.name)}
        description={setting.description ? i18n.t(setting.description) : undefined}
        {disabled}
        badge={lockedByDeployment
          ? i18n.t('settings.managedByDeployment')
          : setting.unavailable
            ? i18n.t('settings.notAvailableYet')
            : gate
              ? i18n.t('settings.needsSetting', { name: i18n.t(gateName(setting)) })
              : unsupported
                ? i18n.t('settings.needsServerFeature')
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
            aria-label={i18n.t(setting.name)}
            value={setting.getValue?.() ?? preferences[key]}
            items={setting.options.map((option) => ({
              value: option.value,
              label: option.literal ? option.label : i18n.t(option.label),
              labelClass: option.literal ? 'literal-label' : undefined,
            }))}
            onValueChange={(value) => {
              if (setting.setValue) setting.setValue(value);
              else setPreference(key, value as Preferences[typeof key]);
              setting.onChange?.(value);
              if (setting.requiresReload) reloadPending = true;
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
              label={i18n.t(setting.name)}
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
                aria-label={i18n.t('settings.rangePercent', { name: i18n.t(setting.name) })}
                onchange={(event) => {
                  const typed = Number(event.currentTarget.value) / 100;
                  if (event.currentTarget.value !== '' && Number.isFinite(typed)) {
                    const { min, max } = PREFERENCE_RANGES[key];
                    const next = clamp(typed, min, max);
                    setPreference(key, next);
                    setting.onChange?.(next);
                  }
                  event.currentTarget.value = String(Math.round(preferences[key] * 100));
                }}
              /><span class="range-suffix" aria-hidden="true">%</span>
            </label>
          </div>
        {:else if setting.type === 'text'}
          {@const key = setting.key}
          <TextInput
            {disabled}
            aria-label={i18n.t(setting.name)}
            value={preferences[key]}
            placeholder={setting.placeholder && i18n.t(setting.placeholder)}
            oninput={(event) => setPreference(key, event.currentTarget.value)}
          />
        {:else}
          {@const key = setting.key}
          <Switch
            id={`${anchor}-switch`}
            {disabled}
            label={i18n.t(setting.name)}
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
      <p>{i18n.t('settings.telemetryReloadNotice')}</p>
      <Button
        variant="secondary"
        size="small"
        onclick={() => {
          location.reload();
        }}
      >
        {i18n.t('common.reload')}
      </Button>
    </Alert>
  {/if}

  {#if tabs.length > 1}
    <div
      class="tabs"
      role="tablist"
      aria-label={i18n.t(category.name)}
      {@attach rovingFocus({ selector: '[role="tab"]' })}
    >
      {#each tabs as tab (tab.id)}
        <button
          type="button"
          role="tab"
          class="tab"
          aria-selected={tab.id === activeTab}
          id={`settings-tab-${tab.id}`}
          aria-controls={`settings-tabpanel-${tab.id}`}
          onfocus={() => selectTab(tab.id)}
          onclick={() => selectTab(tab.id)}
        >
          {i18n.t(tab.name)}
        </button>
      {/each}
    </div>
  {/if}

  {#if tabs.length > 1}
    {#each tabs as tab (tab.id)}
      {#if tab.id === activeTab || visited.has(tab.id)}
        <div
          class="tab-panel"
          role="tabpanel"
          id={`settings-tabpanel-${tab.id}`}
          aria-labelledby={`settings-tab-${tab.id}`}
          hidden={tab.id !== activeTab}
        >
          {#each sections.filter((entry) => tabOf(entry.section) === tab.id) as entry (entry.section.id)}
            {@render sectionBlock(entry)}
          {/each}
        </div>
      {/if}
    {/each}
  {:else}
    {#each sections as entry (entry.section.id)}
      {@render sectionBlock(entry)}
    {/each}
  {/if}

  {#each loosePanels as panel (panel.component)}
    <section class="settings-card"><panel.component /></section>
  {/each}
</div>

<style>
  .tabs {
    border-bottom: var(--border-width) solid var(--surface-var-container-line);
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-100);
  }

  .tab {
    background: none;
    border: 0;
    border-bottom: var(--border-width-600) solid transparent;
    color: var(--surface-var-on-container);
    cursor: pointer;
    font: inherit;
    font-weight: var(--font-weight-medium);
    padding: var(--space-200) var(--space-300);
  }

  .tab[aria-selected='true'] {
    border-bottom-color: var(--primary-main);
    color: var(--surface-on-container);
  }

  .tab:focus-visible {
    outline: var(--focus-ring-width) solid var(--focus-ring);
    outline-offset: calc(-1 * var(--focus-ring-width));
  }

  .tab-panel {
    display: grid;
    gap: var(--space-300);
  }

  .tab-panel[hidden] {
    display: none;
  }

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
