<script lang="ts">
  import { useCoreClient } from '$lib/core/context';
  import { i18n, t } from '$lib/i18n';
  import Button from '$lib/ui/primitives/Button.svelte';
  import TextInput from '$lib/ui/primitives/TextInput.svelte';
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
  let recoveryKey = $state('');
  let creating = $state(false);
  let error = $state<string | null>(null);

  async function createRecoveryKey(): Promise<void> {
    creating = true;
    error = null;
    try {
      recoveryKey = await core.enableRecovery();
    } catch {
      error = t('settings.actionFailed');
    } finally {
      creating = false;
    }
  }

  function selectRecoveryKey(event: Event & { currentTarget: HTMLInputElement }): void {
    event.currentTarget.select();
  }
</script>

<form
  class="recovery-setup-card auth-card-surface"
  aria-labelledby="recovery-setup-title"
  onsubmit={(event) => {
    event.preventDefault();
    if (recoveryKey) onComplete();
    else void createRecoveryKey();
  }}
>
  {#if recoveryKey}
    <AuthField labelId="recovery-setup-title" label={$i18n.t('settings.saveRecoveryKey')}>
      <AuthInfoBox id="new-account-recovery-key-help">
        {$i18n.t('settings.saveRecoveryKeyDescription')}
      </AuthInfoBox>
    </AuthField>

    <AuthField fieldId="new-account-recovery-key" label={$i18n.t('settings.recoveryKey')}>
      <TextInput
        id="new-account-recovery-key"
        value={recoveryKey}
        readonly
        aria-describedby="new-account-recovery-key-help"
        spellcheck={false}
        onclick={selectRecoveryKey}
        onfocus={selectRecoveryKey}
      />
    </AuthField>
  {:else}
    <AuthField labelId="recovery-setup-title" label={$i18n.t('auth.setUpRecovery')}>
      <AuthInfoBox>{$i18n.t('auth.recoverySetupDescription')}</AuthInfoBox>
    </AuthField>
  {/if}

  <AuthStatusSlot message={error} />

  <Button type="submit" variant="primary" block loading={creating}>
    {recoveryKey ? $i18n.t('settings.savedRecoveryKey') : $i18n.t('auth.createRecoveryKey')}
  </Button>
</form>

{#if !recoveryKey}
  <AuthSecondaryAction label={$i18n.t('auth.skipForNow')} onclick={onSkip} />
{/if}

<style>
  .recovery-setup-card {
    min-width: 0;
  }
</style>
