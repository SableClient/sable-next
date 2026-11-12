<script lang="ts">
  import { useCoreClient } from '#lib/core/context.js';
  import { DeviceVerification } from '#lib/core/device-verification.svelte.js';
  import { i18n } from '#lib/i18n.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import Label from '#lib/ui/primitives/Label.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';

  interface Props {
    id: string;
    onUnlocked?: () => void | Promise<void>;
  }

  let { id, onUnlocked }: Props = $props();

  const core = useCoreClient();
  const verification = new DeviceVerification(core);
  let passphrase = $derived(core.encryption?.recovery_passphrase ?? false);
</script>

<form
  class="settings-form"
  onsubmit={(event) => {
    event.preventDefault();
    void verification.recoverIdentity(onUnlocked, passphrase);
  }}
>
  {#if verification.error}<Alert variant="critical" role="alert">{verification.error}</Alert>{/if}
  <Label for={id}
    >{i18n.t(passphrase ? 'settings.useRecoveryKeyOrPassphrase' : 'settings.useRecoveryKey')}</Label
  >
  <div class="controls">
    <TextInput
      {id}
      bind:value={verification.recoveryKey}
      autocomplete="off"
      autocapitalize="none"
      disabled={verification.recovering}
      spellcheck={false}
      type="password"
      placeholder={i18n.t(
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
      {i18n.t('settings.syncEncryptionUnlock')}
    </Button>
  </div>
</form>

<style>
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
