<script lang="ts">
  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import SettingsRow from '#lib/ui/primitives/SettingsRow.svelte';
  import '#lib/ui/primitives/settings-row.css';
  import RecoveryKeyUnlock from './RecoveryKeyUnlock.svelte';

  const core = useCoreClient();

  let recoveryEnabled = $derived(
    core.encryption?.recovery === 'enabled' || core.encryption?.recovery === 'incomplete'
  );
  let sealed = $derived(core.encryption?.account_data_key ?? false);
  let description = $derived(
    sealed
      ? i18n.t('settings.syncEncryptionOn')
      : recoveryEnabled
        ? i18n.t('settings.syncEncryptionLocked')
        : i18n.t('settings.syncEncryptionOff')
  );
</script>

<ul class="settings">
  <SettingsRow id="sync-encryption" title={i18n.t('settings.syncEncryptionTitle')} {description} />
</ul>
{#if recoveryEnabled && !sealed}
  <RecoveryKeyUnlock id="sync-encryption-key" />
{/if}

<style>
  .settings {
    list-style: none;
    margin: 0;
    padding: 0;
  }
</style>
