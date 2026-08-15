<script lang="ts">
  import { i18n } from '$lib/i18n';
  import SettingsSection from '$lib/ui/primitives/SettingsSection.svelte';
  import { settingsCategories } from '$lib/settings/registry';
  import {
    setTimelinePreference,
    timelinePreferences,
  } from '$lib/settings/timeline-preferences.svelte';
</script>

{#each settingsCategories as category (category.id)}
  <SettingsSection
    title={$i18n.t(category.name)}
    description={category.description ? $i18n.t(category.description) : undefined}
    headingId={`settings-${category.id}`}
  >
    <ul class="settings">
      {#each category.items as setting (setting.key)}
        <li>
          <label>
            <input
              type="checkbox"
              checked={timelinePreferences[setting.key]}
              onchange={(event) => {
                setTimelinePreference(setting.key, event.currentTarget.checked);
              }}
            />
            <span>{$i18n.t(setting.name)}</span>
          </label>
          {#if setting.description}
            <p>{$i18n.t(setting.description)}</p>
          {/if}
        </li>
      {/each}
    </ul>
  </SettingsSection>
{/each}

<style>
  .settings {
    display: grid;
    gap: var(--space-3);
    list-style: none;
    margin: 0;
    padding: 0;
  }

  label {
    align-items: center;
    cursor: pointer;
    display: flex;
    font-weight: var(--font-weight-medium);
    gap: var(--space-1);
  }

  input {
    accent-color: var(--sable-primary-main);
    height: 1rem;
    width: 1rem;
  }

  p {
    color: var(--sable-surface-var-on-container);
    font-size: var(--font-size-small);
    margin: 0.125rem 0 0 calc(1rem + var(--space-1));
  }
</style>
