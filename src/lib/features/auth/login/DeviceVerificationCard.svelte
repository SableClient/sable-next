<script lang="ts">
  import type { EncryptionStatusView } from '#src/generated/EncryptionStatusView';
  import { useCoreClient } from '#lib/core/context.js';
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
  let recoveryKey = $state('');
  let requesting = $state(false);
  let recovering = $state(false);
  let error = $state<string | null>(null);
  let verified = $derived(status?.verification === 'verified' || recovered);

  async function refresh(): Promise<void> {
    loading = true;
    error = null;
    try {
      status = await core.commands.encryptionStatus();
    } catch (cause) {
      error = verificationErrorMessage(cause);
    } finally {
      loading = false;
    }
  }

  async function verify(): Promise<void> {
    const key = recoveryKey.trim();
    error = null;
    if (key) {
      recovering = true;
      try {
        await core.commands.recoverIdentity(key);
        recoveryKey = '';
        recovered = true;
      } catch (cause) {
        error = verificationErrorMessage(cause, { invalidRecoveryKey: true });
      } finally {
        recovering = false;
      }
      return;
    }

    if (!core.session?.user_id) return;
    requesting = true;
    try {
      await core.requestVerification(core.session.user_id);
    } catch (cause) {
      error = verificationErrorMessage(cause);
    } finally {
      requesting = false;
    }
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
          bind:value={recoveryKey}
          autocomplete="off"
          autocapitalize="none"
          disabled={requesting || recovering}
          spellcheck={false}
          type="password"
          placeholder={$i18n.t('settings.recoveryKeyPlaceholder')}
        />
      </AuthField>
    {/if}

    <AuthStatusSlot message={error} />

    <Button
      type="submit"
      variant="primary"
      block
      loading={requesting || recovering}
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
