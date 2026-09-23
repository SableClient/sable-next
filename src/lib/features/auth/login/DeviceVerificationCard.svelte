<script lang="ts">
  import type { EncryptionStatusView } from '#src/generated/protocol';
  import { useCoreClient } from '#lib/core/context.js';
  import { DeviceVerification } from '#lib/core/device-verification.svelte.js';
  import { verificationErrorMessage } from '#lib/core/verification-errors.js';
  import { i18n } from '#lib/i18n.js';
  import Button from '#lib/ui/primitives/Button.svelte';
  import Spinner from '#lib/ui/primitives/Spinner.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';
  import AuthField from '../shared/AuthField.svelte';
  import AuthInfoBox from '../shared/AuthInfoBox.svelte';
  import AuthSecondaryAction from '../shared/AuthSecondaryAction.svelte';
  import AuthStatusSlot from '../shared/AuthStatusSlot.svelte';

  interface Props {
    onComplete: () => void;
    onSkip: () => void;
  }

  let { onComplete, onSkip }: Props = $props();
  const core = useCoreClient();
  let status = $state<EncryptionStatusView | null>(null);
  let loading = $state(true);
  let recovered = $state(false);
  const verification = new DeviceVerification(core);
  let verified = $derived(status?.verification === 'verified' || recovered);

  async function refresh(): Promise<void> {
    loading = true;
    verification.error = null;
    try {
      status = await core.commands.encryptionStatus();
    } catch (cause) {
      verification.error = verificationErrorMessage(cause);
    } finally {
      loading = false;
    }
  }

  async function verify(): Promise<void> {
    verification.error = null;
    if (verification.recoveryKey.trim()) {
      await verification.recoverIdentity(() => {
        recovered = true;
      });
      return;
    }
    await verification.requestVerification();
  }

  $effect(() => {
    void refresh();
    return core.subscribeEvents((event) => {
      if (event.type === 'encryption_status') status = event.status;
    });
  });
</script>

<form
  class="device-verification-card auth-card-surface"
  aria-labelledby="device-verification-title"
  onsubmit={(event) => {
    event.preventDefault();
    void verify();
  }}
>
  {#if verified}
    <AuthField labelId="device-verification-title" label={$i18n.t('auth.deviceVerified')}>
      <AuthInfoBox>{$i18n.t('auth.deviceVerifiedDescription')}</AuthInfoBox>
    </AuthField>
    <AuthStatusSlot />
    <Button type="button" variant="primary" block onclick={onComplete}>
      {$i18n.t('auth.continue')}
    </Button>
  {:else}
    <AuthField labelId="device-verification-title" label={$i18n.t('auth.verifyDevice')}>
      <AuthInfoBox>
        {#if loading}<Spinner small />{/if}
        {loading ? $i18n.t('settings.loadingEncryption') : $i18n.t('auth.verifyDeviceDescription')}
      </AuthInfoBox>
    </AuthField>

    {#if status?.recovery !== 'disabled'}
      <AuthField fieldId="login-recovery-key" label={$i18n.t('settings.recoveryKey')}>
        <TextInput
          id="login-recovery-key"
          bind:value={verification.recoveryKey}
          autocomplete="off"
          autocapitalize="none"
          disabled={verification.requesting || verification.recovering}
          spellcheck={false}
          type="password"
          placeholder={$i18n.t('settings.recoveryKeyPlaceholder')}
        />
      </AuthField>
    {/if}

    <AuthStatusSlot message={verification.error} />

    <Button
      type="submit"
      variant="primary"
      block
      loading={verification.requesting || verification.recovering}
      disabled={loading || !status}
    >
      {$i18n.t('settings.verify')}
    </Button>
  {/if}
</form>

{#if !verified}
  <AuthSecondaryAction label={$i18n.t('auth.skipForNow')} onclick={onSkip} />
{/if}

<style>
  .device-verification-card {
    min-width: 0;
  }
</style>
