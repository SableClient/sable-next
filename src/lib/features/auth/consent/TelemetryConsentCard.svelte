<script lang="ts">
  import { i18n } from '#lib/i18n.js';
  import { setPreference } from '#lib/settings/preferences.svelte.js';
  import Button from '#lib/ui/primitives/Button.svelte';
  import AuthField from '../shared/AuthField.svelte';
  import AuthInfoBox from '../shared/AuthInfoBox.svelte';

  interface Props {
    onAnswer: (enabled: boolean) => void;
  }

  let { onAnswer }: Props = $props();

  function answer(enabled: boolean): void {
    setPreference('errorReporting', enabled);
    setPreference('telemetryAsked', true);
    onAnswer(enabled);
  }
</script>

<div class="telemetry-consent-card auth-card-surface">
  <AuthField labelId="telemetry-consent-title" label={$i18n.t('settings.telemetryBannerTitle')}>
    <AuthInfoBox>
      <div class="telemetry-consent-copy">
        <p>{$i18n.t('settings.telemetryBannerHelp')}</p>
        <p>{$i18n.t('settings.telemetryBannerBody')}</p>
        <p>{$i18n.t('settings.telemetryBannerSent')}</p>
      </div>
    </AuthInfoBox>
  </AuthField>

  <div class="telemetry-consent-policies">
    <a href="https://sable.moe/privacy" rel="noopener noreferrer" target="_blank">
      {$i18n.t('settings.telemetryBannerSablePolicy')}
    </a>
  </div>

  <div class="telemetry-consent-actions">
    <Button
      variant="primary"
      block
      onclick={() => {
        answer(true);
      }}
    >
      {$i18n.t('settings.telemetryBannerAccept')}
    </Button>
    <Button
      block
      onclick={() => {
        answer(false);
      }}
    >
      {$i18n.t('settings.telemetryBannerDecline')}
    </Button>
  </div>
</div>

<style>
  .telemetry-consent-card {
    min-width: 0;
  }

  .telemetry-consent-copy {
    display: grid;
    gap: var(--space-100);
  }

  .telemetry-consent-policies {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-200) var(--space-400);
    justify-content: center;
  }

  .telemetry-consent-actions {
    display: grid;
    gap: var(--space-200);
  }
</style>
