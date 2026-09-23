<script lang="ts">
  import { page } from '$app/state';
  import KeyIcon from 'phosphor-svelte/lib/KeyIcon';

  import { useCoreClient } from '#lib/core/context.js';
  import { openSettingsOver } from '#lib/features/settings/settings-navigation.js';
  import { i18n } from '#lib/i18n.js';
  import { SETTINGS_DEVICES_SECTION } from '#lib/settings/registry.js';
  import Banner from '#lib/ui/primitives/Banner.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import { persistedDismissal } from '#lib/ui/persisted-dismissal.svelte.js';

  const core = useCoreClient();
  const dismissal = persistedDismissal('sable-recovery-incomplete-dismissed');
  const deviceId = $derived(core.session?.device_id ?? null);
  const incomplete = $derived(core.encryption?.recovery === 'incomplete');
  const selfUnverified = $derived(core.encryption?.verification === 'unverified');
  const inAppShell = $derived(page.route.id?.startsWith('/(app)') ?? false);
  const show = $derived(
    inAppShell &&
      incomplete &&
      !selfUnverified &&
      deviceId !== null &&
      dismissal.dismissedFor !== deviceId
  );

  function unlock(event: MouseEvent): void {
    openSettingsOver(event, SETTINGS_DEVICES_SECTION);
  }

  function dismiss(): void {
    dismissal.dismiss(deviceId);
  }
</script>

{#if show}
  <Banner icon={KeyIcon} tone="warning" onClose={dismiss}>
    {#snippet title()}
      {$i18n.t('settings.recoveryIncompleteTitle')}
    {/snippet}
    {#snippet body()}
      {$i18n.t('settings.recoveryIncompleteBody')}
    {/snippet}
    {#snippet actions()}
      <Button variant="ghost" size="small" onclick={dismiss}>
        {$i18n.t('settings.unverifiedBannerDismiss')}
      </Button>
      <Button variant="primary" size="small" onclick={unlock}>
        {$i18n.t('settings.recoveryIncompleteAction')}
      </Button>
    {/snippet}
  </Banner>
{/if}
