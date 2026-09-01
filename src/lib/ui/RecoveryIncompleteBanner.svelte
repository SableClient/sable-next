<script lang="ts">
  import { page } from '$app/state';
  import KeyIcon from 'phosphor-svelte/lib/KeyIcon';

  import { useCoreClient } from '#lib/core/context.js';
  import { openSettingsOver } from '#lib/features/settings/settings-navigation.js';
  import { i18n } from '#lib/i18n.js';
  import { SETTINGS_DEVICES_SECTION } from '#lib/settings/registry.js';
  import Banner from '#lib/ui/primitives/Banner.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';

  const STORAGE_KEY = 'sable-recovery-incomplete-dismissed';

  const core = useCoreClient();
  let dismissedFor = $state(read());
  const deviceId = $derived(core.session?.device_id ?? null);
  const incomplete = $derived(core.encryption?.recovery === 'incomplete');
  const selfUnverified = $derived(core.encryption?.verification === 'unverified');
  const inAppShell = $derived(page.route.id?.startsWith('/(app)') ?? false);
  const show = $derived(
    inAppShell && incomplete && !selfUnverified && deviceId !== null && dismissedFor !== deviceId
  );

  function read(): string | null {
    try {
      return localStorage.getItem(STORAGE_KEY);
    } catch {
      return null;
    }
  }

  function unlock(event: MouseEvent): void {
    openSettingsOver(event, SETTINGS_DEVICES_SECTION);
  }

  function dismiss(): void {
    dismissedFor = deviceId;
    try {
      if (deviceId !== null) localStorage.setItem(STORAGE_KEY, deviceId);
    } catch (error) {
      console.debug('[sable settings] dismissal not persisted', error);
    }
  }
</script>

{#if show}
  <Banner icon={KeyIcon} title={$i18n.t('settings.recoveryIncompleteTitle')} tone="warning">
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
