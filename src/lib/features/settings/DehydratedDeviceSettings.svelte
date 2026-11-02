<script lang="ts">
  import type { DehydratedDeviceView } from '#src/generated/protocol';
  import { useCoreClient } from '#lib/core/context.js';
  import { i18n, t } from '#lib/i18n.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import SettingsRow from '#lib/ui/primitives/SettingsRow.svelte';
  import Switch from '#lib/ui/primitives/Switch.svelte';
  import '#lib/ui/primitives/settings-row.css';

  const core = useCoreClient();
  let status = $state<DehydratedDeviceView | null>(null);
  let saving = $state(false);
  let error = $state<string | null>(null);

  $effect(() => {
    void core.session?.account_id;
    void core.encryption?.recovery;
    let active = true;
    status = null;
    error = null;
    core.rpc.encryption
      .dehydratedDevice()
      .then((next) => {
        if (active) status = next;
      })
      .catch(() => {
        if (active) error = t('settings.dehydratedDeviceFailed');
      });
    return () => {
      active = false;
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
{/if}
{#if error}<Alert variant="critical" role="alert">{error}</Alert>{/if}

<style>
  .settings {
    list-style: none;
    margin: 0;
    padding: 0;
  }
</style>
