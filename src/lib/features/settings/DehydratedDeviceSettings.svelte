<script lang="ts">
  import type { DehydratedDeviceView } from '#src/generated/protocol';
  import { useCoreClient } from '#lib/core/context.js';
  import { i18n, t } from '#lib/i18n.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import SettingsRow from '#lib/ui/primitives/SettingsRow.svelte';
  import Switch from '#lib/ui/primitives/Switch.svelte';
  import '#lib/ui/primitives/settings-row.css';
  import RecoveryKeyUnlock from './RecoveryKeyUnlock.svelte';

  const core = useCoreClient();
  let status = $state<DehydratedDeviceView | null>(null);
  let saving = $state(false);
  let error = $state<string | null>(null);

  let generation = 0;
  function refresh(): void {
    const current = ++generation;
    error = null;
    core.rpc.encryption
      .dehydratedDevice()
      .then((next) => {
        if (current === generation) status = next;
      })
      .catch(() => {
        if (current === generation) error = t('settings.dehydratedDeviceFailed');
      });
  }

  $effect(() => {
    void core.session?.account_id;
    void core.encryption?.recovery;
    status = null;
    refresh();
    return () => {
      generation += 1;
    };
  });

  async function setEnabled(enabled: boolean): Promise<void> {
    saving = true;
    error = null;
    try {
      status = await core.rpc.encryption.setDehydratedDevice({ enabled });
    } catch {
      error = t('settings.dehydratedDeviceFailed');
    } finally {
      saving = false;
    }
  }
</script>

{#if status && status !== 'unsupported'}
  <ul class="settings">
    <SettingsRow
      id="dehydrated-device"
      title={i18n.t('settings.dehydratedDevice')}
      description={i18n.t(
        status === 'needs_recovery_key'
          ? 'settings.dehydratedDeviceNeedsRecoveryKey'
          : 'settings.dehydratedDeviceHint'
      )}
      control="dehydrated-device-switch"
    >
      <Switch
        id="dehydrated-device-switch"
        label={i18n.t('settings.dehydratedDevice')}
        checked={status !== 'disabled'}
        disabled={saving}
        onCheckedChange={(checked) => void setEnabled(checked)}
      />
    </SettingsRow>
  </ul>
  {#if status === 'needs_recovery_key'}
    <RecoveryKeyUnlock id="dehydrated-device-key" onUnlocked={refresh} />
  {/if}
{/if}
{#if error}<Alert variant="critical" role="alert">{error}</Alert>{/if}

<style>
  .settings {
    list-style: none;
    margin: 0;
    padding: 0;
  }
</style>
