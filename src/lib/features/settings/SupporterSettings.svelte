<script lang="ts">
  import { currentLocale, i18n } from '#lib/i18n.js';
  import { supporter } from '#lib/supporter/supporter.svelte.js';
  import SupporterBadge from '#lib/supporter/SupporterBadge.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import SettingsRow from '#lib/ui/primitives/SettingsRow.svelte';
  import SettingsSection from '#lib/ui/primitives/SettingsSection.svelte';
  import '#lib/ui/primitives/settings-row.css';

  let badge = $derived(supporter.badge);
  let validUntil = $derived(
    badge?.expiresAt
      ? new Intl.DateTimeFormat(currentLocale(), { dateStyle: 'medium' }).format(
          badge.expiresAt * 1000
        )
      : null
  );
  let waiting = $derived(supporter.status === 'waiting');
  let refreshing = $derived(supporter.status === 'refreshing');
  let checking = $derived(supporter.status === 'checking');
</script>

<SettingsSection title={$i18n.t('settings.supporterTitle')} headingId="about-supporter">
  <ul class="settings">
    {#if badge}
      <SettingsRow
        id="supporter-active"
        title={$i18n.t('settings.supporterActive')}
        description={validUntil
          ? $i18n.t('settings.supporterValidUntil', { date: validUntil })
          : ''}
      >
        <SupporterBadge label={badge.label} />
        {#if badge.expiresAt}
          <Button size="small" loading={refreshing} onclick={() => void supporter.refresh()}>
            {$i18n.t('settings.supporterRefresh')}
          </Button>
        {/if}
        <Button size="small" onclick={() => void supporter.remove()}>
          {$i18n.t('settings.supporterRemove')}
        </Button>
      </SettingsRow>
    {:else}
      <SettingsRow
        id="supporter-verify"
        title={$i18n.t('settings.supporterVerify')}
        description={waiting
          ? $i18n.t('settings.supporterWaiting')
          : $i18n.t('settings.supporterHint')}
      >
        {#if waiting}
          <Button size="small" onclick={() => supporter.cancel()}>
            {$i18n.t('settings.supporterCancel')}
          </Button>
        {:else}
          <Button size="small" onclick={() => void supporter.verify()}>
            {$i18n.t('settings.supporterVerifyAction')}
          </Button>
        {/if}
      </SettingsRow>
    {/if}
    {#if !badge}
      <SettingsRow
        id="supporter-claim"
        title={$i18n.t('settings.supporterClaim')}
        description={$i18n.t('settings.supporterClaimHint')}
      >
        <Button
          size="small"
          loading={checking}
          disabled={waiting}
          onclick={() => void supporter.claim()}
        >
          {$i18n.t('settings.supporterClaimAction')}
        </Button>
      </SettingsRow>
    {/if}
    {#if supporter.status === 'none'}
      <li class="settings-form status" aria-live="polite">{$i18n.t('settings.supporterNone')}</li>
    {/if}
    {#if supporter.status === 'failed'}
      <li class="settings-form error" role="alert">{$i18n.t('settings.supporterFailed')}</li>
    {/if}
  </ul>
</SettingsSection>
