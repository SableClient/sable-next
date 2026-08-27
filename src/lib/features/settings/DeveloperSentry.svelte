<script lang="ts">
  import { i18n } from '#lib/i18n.js';
  import Switch from '#lib/ui/primitives/Switch.svelte';
  import StatusBadge from '#lib/ui/primitives/StatusBadge.svelte';
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
  <div class="status-line">
    <span>{$i18n.t('settings.developerSentryConfigured')}</span>
    <StatusBadge
      label={configured
        ? $i18n.t('settings.developerSentryConfiguredYes')
        : $i18n.t('settings.developerSentryConfiguredNo')}
      variant={configured ? 'success' : 'warning'}
    />
  </div>
  <dl>
    <div>
      <dt>{$i18n.t('settings.developerSentryEnvironment')}</dt>
      <dd>{import.meta.env.MODE}</dd>
    </div>
    <div>
      <dt>{$i18n.t('settings.developerSentryReporting')}</dt>
      <dd>
        {preferences.errorReporting
          ? $i18n.t('settings.developerYes')
          : $i18n.t('settings.developerNo')}
      </dd>
    </div>
    <div>
      <dt>{$i18n.t('settings.developerSentryReplay')}</dt>
      <dd>
        {preferences.sessionReplay
          ? $i18n.t('settings.developerYes')
          : $i18n.t('settings.developerNo')}
      </dd>
    </div>
    <div>
      <dt>{$i18n.t('settings.developerSentryActivity')}</dt>
      <dd>
        {errors}
        {$i18n.t('settings.developerSentryErrors')}, {warnings}
        {$i18n.t('settings.developerSentryWarnings')}
      </dd>
    </div>
  </dl>
  <p>{$i18n.t('settings.developerSentryDescription')}</p>
  <div class="categories">
    {#each categories as category (category)}
      <div class="category">
        <span>{category}</span>
        <Switch
          label={`${category} breadcrumbs`}
          checked={!debugLog.disabledCategories.has(category)}
          onCheckedChange={(enabled) => setDebugCategoryEnabled(category, enabled)}
        />
      </div>
    {/each}
  </div>
</div>

<style>
  .sentry,
  dl,
  .categories {
    display: grid;
    gap: var(--space-2);
  }

  .status-line,
  dl div,
  .category {
    align-items: center;
    display: flex;
    gap: var(--space-2);
    justify-content: space-between;
  }

  dl {
    margin: 0;
  }

  dt,
  dd,
  p {
    margin: 0;
  }

  dt,
  p {
    color: var(--sable-surface-var-on-container);
  }

  dd {
    font-family: var(--font-family-mono);
    text-align: right;
  }

  .categories {
    border-top: var(--border-width) solid var(--sable-surface-container-line);
    padding-top: var(--space-2);
  }
</style>
