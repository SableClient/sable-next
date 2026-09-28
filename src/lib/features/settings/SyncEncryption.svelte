<script lang="ts">
  import { useCoreClient } from '#lib/core/context.js';
  import { DeviceVerification } from '#lib/core/device-verification.svelte.js';
  import { i18n } from '#lib/i18n.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import Label from '#lib/ui/primitives/Label.svelte';
  import SettingsRow from '#lib/ui/primitives/SettingsRow.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';
  import '#lib/ui/primitives/settings-row.css';

  const core = useCoreClient();
  const verification = new DeviceVerification(core);

  let recoveryEnabled = $derived(
    core.encryption?.recovery === 'enabled' || core.encryption?.recovery === 'incomplete'
  );
  let sealed = $derived(core.encryption?.account_data_key ?? false);
  let passphrase = $derived(core.encryption?.recovery_passphrase ?? false);
  let description = $derived(
    sealed
      ? $i18n.t('settings.syncEncryptionOn')
      : recoveryEnabled
        ? $i18n.t('settings.syncEncryptionLocked')
        : $i18n.t('settings.syncEncryptionOff')
  );
</script>

<ul class="settings">
  <SettingsRow id="sync-encryption" title={$i18n.t('settings.syncEncryptionTitle')} {description} />
</ul>
{#if recoveryEnabled && !sealed}
  <form
    class="settings-form"
    onsubmit={(event) => {
      event.preventDefault();
      void verification.recoverIdentity(undefined, passphrase);
    }}
  >
    {#if verification.error}<Alert variant="critical" role="alert">{verification.error}</Alert>{/if}
    <Label for="sync-encryption-key"
      >{$i18n.t(
        passphrase ? 'settings.useRecoveryKeyOrPassphrase' : 'settings.useRecoveryKey'
      )}</Label
    >
    <div class="controls">
      <TextInput
        id="sync-encryption-key"
        bind:value={verification.recoveryKey}
        autocomplete="off"
        autocapitalize="none"
        disabled={verification.recovering}
        spellcheck={false}
        type="password"
        placeholder={$i18n.t(
          passphrase
            ? 'settings.recoveryKeyOrPassphrasePlaceholder'
            : 'settings.recoveryKeyPlaceholder'
        )}
      />
      <Button
        type="submit"
        loading={verification.recovering}
        disabled={!verification.recoveryKey.trim()}
      >
        {$i18n.t('settings.syncEncryptionUnlock')}
      </Button>
    </div>
  </form>
{/if}

<style>
  .settings {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .settings-form {
    display: grid;
    gap: var(--space-200);
  }

  .controls {
    display: grid;
    gap: var(--space-200);
    grid-template-columns: 1fr;
  }

  @media (width >= 42rem) {
    .controls {
      grid-template-columns: minmax(0, 1fr) auto;
    }
  }
</style>
