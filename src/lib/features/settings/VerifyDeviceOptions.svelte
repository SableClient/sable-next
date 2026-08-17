<script lang="ts">
  import ArrowLeftIcon from 'phosphor-svelte/lib/ArrowLeftIcon';
  import DesktopTowerIcon from 'phosphor-svelte/lib/DesktopTowerIcon';
  import KeyIcon from 'phosphor-svelte/lib/KeyIcon';

  import type { RecoveryStateView } from '@/generated/RecoveryStateView';
  import { useCoreClient } from '$lib/core/context';
  import { verificationErrorMessage } from '$lib/core/verification-errors';
  import { i18n } from '$lib/i18n';
  import Alert from '$lib/ui/primitives/Alert.svelte';
  import Button from '$lib/ui/primitives/Button.svelte';
  import Label from '$lib/ui/primitives/Label.svelte';
  import TextInput from '$lib/ui/primitives/TextInput.svelte';

  interface Props {
    recovery: RecoveryStateView;
    inputId?: string;
    onRequested?: () => void | Promise<void>;
    onRecovered?: () => void | Promise<void>;
  }

  let { recovery, inputId = 'device-recovery-key', onRequested, onRecovered }: Props = $props();
  const core = useCoreClient();
  let recoveryKey = $state('');
  let recovering = $state(false);
  let requesting = $state(false);
  let error = $state<string | null>(null);
  let selectedMethod = $state<'recovery' | null>(null);

  async function startVerification(): Promise<void> {
    if (!core.session?.user_id) return;
    requesting = true;
    error = null;
    try {
      await core.requestVerification(core.session.user_id);
      await onRequested?.();
    } catch (cause) {
      error = verificationErrorMessage(cause);
    } finally {
      requesting = false;
    }
  }

  async function recoverIdentity(): Promise<void> {
    const key = recoveryKey.trim();
    if (!key) return;
    recovering = true;
    error = null;
    try {
      await core.recoverIdentity(key);
      recoveryKey = '';
      await onRecovered?.();
    } catch (cause) {
      error = verificationErrorMessage(cause, { invalidRecoveryKey: true });
    } finally {
      recovering = false;
    }
  }
</script>

<div class="verification-methods">
  {#if error}<Alert variant="critical" role="alert">{error}</Alert>{/if}

  {#if selectedMethod === null}
    <div class="method-choices">
      <Button block variant="secondary" loading={requesting} onclick={startVerification}>
        <DesktopTowerIcon aria-hidden="true" />
        {$i18n.t('settings.anotherSignedInDevice')}
      </Button>
      {#if recovery !== 'disabled'}
        <Button block variant="secondary" onclick={() => (selectedMethod = 'recovery')}>
          <KeyIcon aria-hidden="true" />
          {$i18n.t('settings.useRecoveryKey')}
        </Button>
      {/if}
    </div>
  {:else}
    <Button
      class="method-back"
      variant="ghost"
      size="small"
      onclick={() => {
        selectedMethod = null;
        error = null;
      }}
    >
      <ArrowLeftIcon aria-hidden="true" />
      {$i18n.t('settings.back')}
    </Button>

    <form
      class="verification-method recovery-method"
      onsubmit={(event) => {
        event.preventDefault();
        void recoverIdentity();
      }}
    >
      <Label for={inputId}>{$i18n.t('settings.useRecoveryKey')}</Label>
      <div class="recovery-controls">
        <TextInput
          id={inputId}
          bind:value={recoveryKey}
          autocomplete="off"
          autocapitalize="none"
          disabled={recovering}
          autofocus
          spellcheck={false}
          type="password"
          placeholder={$i18n.t('settings.recoveryKeyPlaceholder')}
        />
        <Button type="submit" loading={recovering} disabled={!recoveryKey.trim()}>
          {$i18n.t('settings.verify')}
        </Button>
      </div>
    </form>
  {/if}
</div>

<style>
  .verification-methods {
    display: grid;
    gap: var(--space-2);
  }

  .method-choices {
    display: grid;
    gap: var(--space-2);
  }

  .method-choices :global(.sable-button) {
    justify-content: flex-start;
  }

  .method-choices :global(svg),
  :global(.method-back svg) {
    flex: 0 0 auto;
    height: var(--icon-size-medium);
    width: var(--icon-size-medium);
  }

  :global(.method-back) {
    justify-self: start;
  }

  .recovery-method {
    align-items: end;
    display: grid;
    gap: var(--space-1);
  }

  .recovery-controls {
    display: grid;
    gap: var(--space-1);
    grid-template-columns: 1fr;
  }

  @media (width >= 42rem) {
    .recovery-controls {
      grid-template-columns: minmax(0, 1fr) auto;
    }
  }
</style>
