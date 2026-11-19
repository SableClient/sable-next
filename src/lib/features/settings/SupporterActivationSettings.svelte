<script lang="ts">
  import { i18n } from '#lib/i18n.js';
  import { supporter } from '#lib/supporter/supporter.svelte.js';
  import Button from '#lib/ui/primitives/Button.svelte';
  import SettingsRow from '#lib/ui/primitives/SettingsRow.svelte';
  import SettingsSection from '#lib/ui/primitives/SettingsSection.svelte';
  import '#lib/ui/primitives/settings-row.css';
  import { goto } from '$app/navigation';
  import { resolve } from '$app/paths';
  import { settingsState } from './settings-navigation.js';

  let badge = $derived(supporter.badge);

  let waiting = $derived(supporter.status === 'waiting');
  let checking = $derived(supporter.status === 'checking');
</script>

<SettingsSection title={i18n.t('settings.supporterTitle')} headingId="about-supporter">
  <ul class="settings-rows">
    {#if !!badge}
      <SettingsRow
        title={i18n.t('settings.supporterThanksTitle')}
        description={i18n.t('settings.supporterThanksDescription')}
      >
        <Button
          size="small"
          onclick={() =>
            goto(resolve(`settings/account?focus=account-supporter`), {
              shallow: true,
              replace: true,
              state: settingsState('account', 'account-supporter'),
            })}
        >
          {i18n.t('settings.supporterThanksButton')}
        </Button>
      </SettingsRow>
    {:else}
      <SettingsRow
        id="supporter-beg"
        title={i18n.t('settings.supporterBegTitle')}
        description={i18n.t('settings.supporterBegDescription')}
      >
        <Button size="small" onclick={() => void supporter.verify()}>
          {i18n.t('common.supportSable')}
        </Button>
      </SettingsRow>
      <SettingsRow
        id="supporter-verify"
        title={i18n.t('settings.supporterVerifyTitle')}
        description={waiting
          ? i18n.t('settings.supporterWaiting')
          : i18n.t('settings.supporterVerifyDescription')}
      >
        {#if waiting}
          <Button size="small" onclick={() => supporter.cancel()}>
            {i18n.t('common.cancel')}
          </Button>
        {:else}
          <Button size="small" onclick={() => void supporter.verify()}>
            {i18n.t('settings.supporterVerifyButton')}
          </Button>
        {/if}
        <Button
          size="small"
          loading={checking}
          disabled={waiting}
          onclick={() => void supporter.claim()}
        >
          {i18n.t('settings.supporterVerifyClaim')}
        </Button>
      </SettingsRow>

      {#if supporter.status === 'none'}
        <li class="settings-form status" aria-live="polite">{i18n.t('settings.supporterNone')}</li>
      {/if}
      {#if supporter.status === 'failed'}
        <li class="settings-form error" role="alert">{i18n.t('settings.supporterTimedOut')}</li>
      {:else if supporter.status === 'error'}
        <li class="settings-form error" role="alert">{i18n.t('settings.supporterError')}</li>
      {/if}
    {/if}
  </ul>
</SettingsSection>
