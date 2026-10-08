<script lang="ts" module>
  export function priorityProvider() {
    const core = useCoreClient();
    const dismissal = persistedDismissal('sable-unverified-dismissed');
    const deviceId = $derived(core.session?.device_id ?? null);
    const selfUnverified = $derived(core.encryption?.verification === 'unverified');
    const otherUnverified = $derived(
      core.deviceList.filter((device) => !device.is_own && device.has_keys && !device.is_verified)
        .length
    );
    const dismissKey = $derived(
      deviceId === null
        ? null
        : `${deviceId}:${selfUnverified ? 'self' : ''}:${String(otherUnverified)}`
    );
    const show = $derived(
      (selfUnverified || otherUnverified > 0) &&
        dismissKey !== null &&
        dismissal.dismissedFor !== dismissKey
    );

    return {
      get priority(): Priority {
        if (show) {
          return 'security';
        } else {
          return null;
        }
      },

      dismiss() {
        dismissal.dismiss(dismissKey);
      },
    };
  }
</script>

<script lang="ts">
  import ShieldWarningIcon from 'phosphor-svelte/lib/ShieldWarningIcon';

  import { useCoreClient } from '#lib/core/context.js';
  import { openSettingsOver } from '#lib/features/settings/settings-navigation.js';
  import { i18n } from '#lib/i18n.js';
  import { SETTINGS_DEVICES_SECTION } from '#lib/settings/registry.js';
  import Banner from '#lib/ui/primitives/Banner.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import { persistedDismissal } from '#lib/ui/persisted-dismissal.svelte.js';
  import type { Priority, PriorityProvider } from '#lib/features/sidebar/alerts.js';

  let { dismiss }: PriorityProvider = $props();

  const core = useCoreClient();
  const selfUnverified = $derived(core.encryption?.verification === 'unverified');
  const otherUnverified = $derived(
    core.deviceList.filter((device) => !device.is_own && device.has_keys && !device.is_verified)
      .length
  );

  const bannerTitle = $derived(
    selfUnverified
      ? $i18n.t('settings.unverifiedBannerTitle')
      : $i18n.t('settings.unverifiedOthersTitle', { count: otherUnverified })
  );

  function verify(event: MouseEvent): void {
    openSettingsOver(event, SETTINGS_DEVICES_SECTION);
  }
</script>

<Banner icon={ShieldWarningIcon} tone="warning">
  {#snippet title()}
    {bannerTitle}
  {/snippet}
  {#snippet body()}
    {selfUnverified
      ? $i18n.t('settings.unverifiedBannerBody')
      : $i18n.t('settings.unverifiedOthersBody', { count: otherUnverified })}
  {/snippet}
  {#snippet actions()}
    <Button variant="ghost" size="small" onclick={dismiss}>
      {$i18n.t('common.dismiss')}
    </Button>
    <Button variant="primary" size="small" onclick={verify}>
      {$i18n.t('common.verify')}
    </Button>
  {/snippet}
</Banner>
