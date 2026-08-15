<script lang="ts">
  import { i18n } from '$lib/i18n';
  import SettingsSection from '$lib/ui/primitives/SettingsSection.svelte';
  import Switch from '$lib/ui/primitives/Switch.svelte';
  import { settingsCategories } from '$lib/settings/registry';
  import type { SettingDefinition } from '$lib/settings/registry';
  import {
    setTimelinePreference,
    timelinePreferences,
  } from '$lib/settings/timeline-preferences.svelte';
  import type { TimelineLayout } from '$lib/settings/timeline-preferences.svelte';

  import StateEventTool from './StateEventTool.svelte';

  function gated(setting: SettingDefinition): boolean {
    return setting.gatedBy !== undefined && !timelinePreferences[setting.gatedBy];
  }
</script>

{#each settingsCategories as category (category.id)}
  <SettingsSection
    title={$i18n.t(category.name)}
    description={category.description ? $i18n.t(category.description) : undefined}
    headingId={`settings-${category.id}`}
  >
    <ul class="settings">
      {#each category.items as setting (setting.key)}
        {@const disabled = gated(setting)}
        <li class={{ gated: setting.gatedBy !== undefined, disabled }}>
          <div class="row">
            <span class="copy">
              <span class="name">{$i18n.t(setting.name)}</span>
              {#if setting.description}
                <span class="hint">{$i18n.t(setting.description)}</span>
              {/if}
            </span>
            {#if setting.type === 'select'}
              <select
                {disabled}
                aria-label={$i18n.t(setting.name)}
                value={timelinePreferences[setting.key]}
                onchange={(event) => {
                  setTimelinePreference('layout', event.currentTarget.value as TimelineLayout);
                }}
              >
                {#each setting.options as option (option.value)}
                  <option value={option.value}>{$i18n.t(option.label)}</option>
                {/each}
              </select>
            {:else}
              {@const key = setting.key}
              <Switch
                {disabled}
                label={$i18n.t(setting.name)}
                checked={timelinePreferences[key]}
                onCheckedChange={(checked: boolean) => {
                  setTimelinePreference(key, checked);
                }}
              />
            {/if}
          </div>
        </li>
      {/each}
    </ul>
  </SettingsSection>
{/each}

{#if timelinePreferences.showHiddenEvents}
  <SettingsSection
    title={$i18n.t('settings.stateEventTitle')}
    headingId="settings-state-event"
    class="state-event-section"
  >
    <StateEventTool />
  </SettingsSection>
{/if}

<style>
  .settings {
    display: grid;
    gap: var(--space-3);
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .gated {
    border-inline-start: 1px solid var(--sable-surface-var-container-line);
    padding-inline-start: var(--space-3);
  }

  .disabled {
    opacity: 0.55;
  }

  .row {
    align-items: center;
    display: flex;
    gap: var(--space-3);
    justify-content: space-between;
  }

  .copy {
    display: grid;
    min-width: 0;
  }

  .name {
    font-weight: var(--font-weight-medium);
  }

  .hint {
    color: var(--sable-surface-var-on-container);
    font-size: var(--font-size-small);
  }

  :global(.state-event-section .settings-section-content) {
    padding: var(--space-3);
  }

  select {
    background: var(--sable-surface-var-container);
    border: 1px solid var(--sable-surface-var-container-line);
    border-radius: var(--radius);
    color: inherit;
    font: inherit;
    font-size: var(--font-size-small);
    padding: 0.25rem var(--space-1);
  }
</style>
