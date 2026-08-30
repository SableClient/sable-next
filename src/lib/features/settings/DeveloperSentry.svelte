<script lang="ts">
  import { i18n } from '#lib/i18n.js';
  import BugIcon from 'phosphor-svelte/lib/BugIcon';
  import CodeIcon from 'phosphor-svelte/lib/CodeIcon';
  import FilmStripIcon from 'phosphor-svelte/lib/FilmStripIcon';
  import PulseIcon from 'phosphor-svelte/lib/PulseIcon';
  import Switch from '#lib/ui/primitives/Switch.svelte';
  import StatusBadge from '#lib/ui/primitives/StatusBadge.svelte';
  import SettingsRow from '#lib/ui/primitives/SettingsRow.svelte';
  import {
    debugLog,
    setDebugCategoryEnabled,
    type DebugLogCategory,
  } from '#lib/observability/debug-log.svelte.js';
  import { preferences } from '#lib/settings/preferences.svelte.js';

  const categories: DebugLogCategory[] = [
    'sync',
    'network',
    'notification',
    'message',
    'media',
    'call',
    'ui',
    'timeline',
    'error',
    'general',
  ];
  let errors = $derived(debugLog.entries.filter((entry) => entry.level === 'error').length);
  let warnings = $derived(debugLog.entries.filter((entry) => entry.level === 'warn').length);
  let configured = $derived(Boolean(import.meta.env.VITE_SENTRY_DSN));
</script>

<div class="sentry">
  <ul class="settings">
    <SettingsRow title={$i18n.t('settings.developerSentryConfigured')} icon={BugIcon}>
      <StatusBadge
        label={configured
          ? $i18n.t('settings.developerSentryConfiguredYes')
          : $i18n.t('settings.developerSentryConfiguredNo')}
        variant={configured ? 'success' : 'warning'}
      />
    </SettingsRow>
    <SettingsRow title={$i18n.t('settings.developerSentryEnvironment')} icon={CodeIcon}>
      <code>{import.meta.env.MODE}</code>
    </SettingsRow>
    <SettingsRow title={$i18n.t('settings.developerSentryReporting')} icon={BugIcon}>
      <code>
        {preferences.errorReporting
          ? $i18n.t('settings.developerYes')
          : $i18n.t('settings.developerNo')}
      </code>
    </SettingsRow>
    <SettingsRow title={$i18n.t('settings.developerSentryReplay')} icon={FilmStripIcon}>
      <code>
        {preferences.sessionReplay
          ? $i18n.t('settings.developerYes')
          : $i18n.t('settings.developerNo')}
      </code>
    </SettingsRow>
    <SettingsRow title={$i18n.t('settings.developerSentryActivity')} icon={PulseIcon}>
      <code>
        {errors}
        {$i18n.t('settings.developerSentryErrors')}, {warnings}
        {$i18n.t('settings.developerSentryWarnings')}
      </code>
    </SettingsRow>
  </ul>
  <p>{$i18n.t('settings.developerSentryDescription')}</p>
  <ul class="categories">
    {#each categories as category (category)}
      <SettingsRow title={`${category} breadcrumbs`} icon={BugIcon}>
        <Switch
          label={`${category} breadcrumbs`}
          checked={!debugLog.disabledCategories.has(category)}
          onCheckedChange={(enabled) => setDebugCategoryEnabled(category, enabled)}
        />
      </SettingsRow>
    {/each}
  </ul>
</div>

<style>
  .sentry,
  .settings,
  .categories {
    display: grid;
    gap: var(--space-300);
  }

  .settings {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  p {
    color: var(--sable-surface-var-on-container);
    margin: 0;
  }

  code {
    font-family: var(--font-family-mono);
    text-align: right;
  }

  .categories {
    border-top: var(--border-width) solid var(--sable-surface-container-line);
    list-style: none;
    margin: 0;
    padding-left: 0;
    padding-top: var(--space-300);
  }
</style>
