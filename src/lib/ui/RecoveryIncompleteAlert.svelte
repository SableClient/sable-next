<script lang="ts" module>
  export function priorityProvider() {
    const core = useCoreClient();
    const dismissal = persistedDismissal('sable-recovery-incomplete-dismissed');
    const deviceId = $derived(core.session?.device_id ?? null);
    const incomplete = $derived(
      core.encryption?.recovery === 'incomplete' && !core.encryption.backup_unlocked
    );
    const selfUnverified = $derived(core.encryption?.verification === 'unverified');
    const show = $derived(
      incomplete && !selfUnverified && deviceId !== null && dismissal.dismissedFor !== deviceId
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
        dismissal.dismiss(deviceId);
      },
    };
  }
</script>

<script lang="ts">
  import KeyIcon from 'phosphor-svelte/lib/KeyIcon';

  import { useCoreClient } from '#lib/core/context.js';
  import { openSettingsOver } from '#lib/features/settings/settings-navigation.js';
  import { i18n } from '#lib/i18n.js';
  import { SETTINGS_DEVICES_SECTION } from '#lib/settings/registry.js';
  import Banner from '#lib/ui/primitives/Banner.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import { persistedDismissal } from '#lib/ui/persisted-dismissal.svelte.js';
  import type { Priority, PriorityProvider } from '#lib/features/sidebar/alerts.js';

  let { dismiss }: PriorityProvider = $props();

  function unlock(event: MouseEvent): void {
    openSettingsOver(event, SETTINGS_DEVICES_SECTION);
  }
</script>

<Banner icon={KeyIcon} tone="warning">
  {#snippet title()}
    {$i18n.t('settings.recoveryIncompleteTitle')}
  {/snippet}
  {#snippet body()}
    {$i18n.t('settings.recoveryIncompleteBody')}
  {/snippet}
  {#snippet actions()}
    <Button variant="ghost" size="small" onclick={dismiss}>
      {$i18n.t('common.dismiss')}
    </Button>
    <Button variant="primary" size="small" onclick={unlock}>
      {$i18n.t('settings.recoveryIncompleteAction')}
    </Button>
  {/snippet}
</Banner>
