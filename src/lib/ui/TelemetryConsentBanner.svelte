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
  <Banner icon={ShieldCheckIcon} title={$i18n.t('settings.telemetryBannerTitle')}>
    {#snippet body()}
      {$i18n.t('settings.telemetryBannerBody')}
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
        variant="primary"
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
