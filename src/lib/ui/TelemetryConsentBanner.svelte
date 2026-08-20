<script lang="ts">
  import ShieldCheckIcon from 'phosphor-svelte/lib/ShieldCheckIcon';

  import { i18n } from '#lib/i18n.js';
  import { preferences, setPreference } from '#lib/settings/preferences.svelte.js';
  import Button from '#lib/ui/primitives/Button.svelte';

  const configured = Boolean(import.meta.env.VITE_SENTRY_DSN);
  let answered = $state(preferences.telemetryAsked);

  function answer(enabled: boolean): void {
    setPreference('errorReporting', enabled);
    setPreference('telemetryAsked', true);
    answered = true;
    // Sentry.init already ran without a DSN this page load.
    if (enabled) location.reload();
  }
</script>

{#if configured && !answered}
  <aside class="consent" role="status" aria-label={$i18n.t('settings.telemetryBannerTitle')}>
    <span class="icon" aria-hidden="true"><ShieldCheckIcon /></span>
    <div class="copy">
      <p class="title">{$i18n.t('settings.telemetryBannerTitle')}</p>
      <p class="body">{$i18n.t('settings.telemetryBannerBody')}</p>
    </div>
    <div class="actions">
      <Button
        variant="ghost"
        size="small"
        onclick={() => {
          answer(false);
        }}
      >
        {$i18n.t('settings.telemetryBannerDecline')}
      </Button>
      <Button
        variant="primary"
        size="small"
        onclick={() => {
          answer(true);
        }}
      >
        {$i18n.t('settings.telemetryBannerAccept')}
      </Button>
    </div>
  </aside>
{/if}

<style>
  .consent {
    align-items: center;
    background: var(--sable-bg-container);
    border: 1px solid var(--sable-bg-container-line);
    border-radius: var(--radius-card);
    bottom: var(--space-3);
    box-shadow: var(--shadow-dialog);
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-3);
    inset-inline: var(--space-3);
    margin-inline: auto;
    max-width: 34rem;
    padding: var(--space-3);
    position: fixed;
    z-index: 100;
  }

  .icon {
    align-items: center;
    background: var(--sable-surface-container);
    border-radius: var(--radius);
    color: var(--sable-surface-var-on-container);
    display: flex;
    flex: 0 0 auto;
    height: var(--control-height-medium);
    justify-content: center;
    width: var(--control-height-medium);
  }

  .icon :global(svg) {
    height: var(--icon-size-medium);
    width: var(--icon-size-medium);
  }

  .copy {
    flex: 1;
    min-width: 0;
  }

  .title {
    font-weight: var(--font-weight-medium);
    margin: 0;
  }

  .body {
    color: var(--sable-surface-var-on-container);
    font-size: var(--font-size-small);
    margin: calc(var(--space-1) / 2) 0 0;
  }

  .actions {
    display: flex;
    flex: 0 0 auto;
    gap: var(--space-2);
    justify-content: flex-end;
    width: 100%;
  }

  @media (width >= 42rem) {
    .consent {
      flex-wrap: nowrap;
    }

    .actions {
      justify-content: normal;
      width: auto;
    }
  }
</style>
