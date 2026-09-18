<script lang="ts">
  import ShieldCheckIcon from 'phosphor-svelte/lib/ShieldCheckIcon';

  import { i18n } from '#lib/i18n.js';
  import { preferences, setPreference } from '#lib/settings/preferences.svelte.js';
  import Banner from '#lib/ui/primitives/Banner.svelte';
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
  <Banner
    icon={ShieldCheckIcon}
    onClose={() => {
      answer(false);
    }}
  >
    {#snippet title()}
      {$i18n.t('settings.telemetryBannerTitle')}
    {/snippet}
    {#snippet body()}
      <div>
        {$i18n.t('settings.telemetryBannerHelp')}
        <br />
        {$i18n.t('settings.telemetryBannerBody')}
        <br />
        {$i18n.t('settings.telemetryBannerSent')}
        <div class="policies">
          <a href="https://github.com/SableClient/Sable/blob/dev/docs/PRIVACY.md"
            >{$i18n.t('settings.telemetryBannerSablePolicy')}</a
          >
          <a href="https://sentry.io/privacy/">{$i18n.t('settings.telemetryBannerSentryPolicy')}</a>
        </div>
      </div>
    {/snippet}
    {#snippet actions()}
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
        variant="ghost"
        size="small"
        onclick={() => {
          answer(true);
        }}
      >
        {$i18n.t('settings.telemetryBannerAccept')}
      </Button>
    {/snippet}
  </Banner>
{/if}

<style>
  .policies {
    display: flex;
    justify-content: space-evenly;
  }

  .policies > a {
    margin: var(--space-200);
  }
</style>
