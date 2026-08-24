<script lang="ts">
  import { page } from '$app/state';
  import ShieldWarningIcon from 'phosphor-svelte/lib/ShieldWarningIcon';

  import { useCoreClient } from '#lib/core/context.js';
  import { openSettingsOver } from '#lib/features/settings/settings-navigation.js';
  import { i18n } from '#lib/i18n.js';
  import { SETTINGS_DEVICES_SECTION } from '#lib/settings/registry.js';
  import Banner from '#lib/ui/primitives/Banner.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';

  const STORAGE_KEY = 'sable-unverified-dismissed';

  const core = useCoreClient();
  let dismissedFor = $state(read());
  const deviceId = $derived(core.session?.device_id ?? null);
  const selfUnverified = $derived(core.encryption?.verification === 'unverified');
  const otherUnverified = $derived(
    core.deviceList.filter((device) => !device.is_own && !device.is_verified).length
  );
  const inAppShell = $derived(page.route.id?.startsWith('/(app)') ?? false);
  const dismissKey = $derived(
    deviceId === null
      ? null
      : `${deviceId}:${selfUnverified ? 'self' : ''}:${String(otherUnverified)}`
  );
  const show = $derived(
    inAppShell &&
      (selfUnverified || otherUnverified > 0) &&
      dismissKey !== null &&
      dismissedFor !== dismissKey
  );

  const title = $derived(
    selfUnverified
      ? $i18n.t('settings.unverifiedBannerTitle')
      : $i18n.t('settings.unverifiedOthersTitle', { count: otherUnverified })
  );

  function read(): string | null {
    try {
      return localStorage.getItem(STORAGE_KEY);
    } catch {
      return null;
    }
  }

  function verify(event: MouseEvent): void {
    openSettingsOver(event, SETTINGS_DEVICES_SECTION);
  }

  function dismiss(): void {
    dismissedFor = dismissKey;
    try {
      if (dismissKey !== null) localStorage.setItem(STORAGE_KEY, dismissKey);
    } catch (error) {
      console.debug('[sable settings] dismissal not persisted', error);
    }
  }
</script>

{#if show}
  <Banner icon={ShieldWarningIcon} {title} tone="warning">
    {#snippet body()}
      {selfUnverified
        ? $i18n.t('settings.unverifiedBannerBody')
        : $i18n.t('settings.unverifiedOthersBody', { count: otherUnverified })}
    {/snippet}
    {#snippet actions()}
      <Button variant="ghost" size="small" onclick={dismiss}>
        {$i18n.t('settings.unverifiedBannerDismiss')}
      </Button>
      <Button variant="primary" size="small" onclick={verify}>
        {$i18n.t('settings.unverifiedBannerVerify')}
      </Button>
    {/snippet}
  </Banner>
{/if}
