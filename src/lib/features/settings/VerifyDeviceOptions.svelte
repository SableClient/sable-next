<script lang="ts">
  import ArrowLeftIcon from 'phosphor-svelte/lib/ArrowLeftIcon';
  import DesktopTowerIcon from 'phosphor-svelte/lib/DesktopTowerIcon';
  import KeyIcon from 'phosphor-svelte/lib/KeyIcon';

  import type { RecoveryStateView } from '#src/generated/protocol';
  import { useCoreClient } from '#lib/core/context.js';
  import { DeviceVerification } from '#lib/core/device-verification.svelte.js';
  import { i18n } from '#lib/i18n.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import Label from '#lib/ui/primitives/Label.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';

  interface Props {
    recovery: RecoveryStateView;
    recoveryPassphrase?: boolean;
    inputId?: string;
    onRequested?: () => void | Promise<void>;
    onRecovered?: () => void | Promise<void>;
  }

  let {
    recovery,
    recoveryPassphrase = false,
    inputId = 'device-recovery-key',
    onRequested,
    onRecovered,
  }: Props = $props();
  const verification = new DeviceVerification(useCoreClient());
  let selectedMethod = $state<'recovery' | null>(null);
</script>

<div class="verification-methods">
  {#if verification.error}<Alert variant="critical" role="alert">{verification.error}</Alert>{/if}

  {#if selectedMethod === null}
    <div class="method-choices">
      <Button
        block
        variant="secondary"
        loading={verification.requesting}
        onclick={() => verification.requestVerification(onRequested)}
      >
        <DesktopTowerIcon aria-hidden="true" />
        {$i18n.t('settings.anotherSignedInDevice')}
      </Button>
      {#if recovery !== 'disabled'}
        <Button block variant="secondary" onclick={() => (selectedMethod = 'recovery')}>
          <KeyIcon aria-hidden="true" />
          {$i18n.t(
            recoveryPassphrase ? 'settings.useRecoveryKeyOrPassphrase' : 'settings.useRecoveryKey'
          )}
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
        verification.error = null;
      }}
    >
      <ArrowLeftIcon aria-hidden="true" />
      {$i18n.t('settings.back')}
    </Button>

    <form
      class="verification-method recovery-method"
      onsubmit={(event) => {
        event.preventDefault();
        void verification.recoverIdentity(onRecovered, recoveryPassphrase);
      }}
    >
      <Label for={inputId}
        >{$i18n.t(
          recoveryPassphrase ? 'settings.useRecoveryKeyOrPassphrase' : 'settings.useRecoveryKey'
        )}</Label
      >
      <div class="recovery-controls">
        <TextInput
          id={inputId}
          bind:value={verification.recoveryKey}
          autocomplete="off"
          autocapitalize="none"
          disabled={verification.recovering}
          autofocus
          spellcheck={false}
          type="password"
          placeholder={$i18n.t(
            recoveryPassphrase
              ? 'settings.recoveryKeyOrPassphrasePlaceholder'
              : 'settings.recoveryKeyPlaceholder'
          )}
        />
        <Button
          type="submit"
          loading={verification.recovering}
          disabled={!verification.recoveryKey.trim()}
        >
          {$i18n.t('settings.verify')}
        </Button>
      </div>
    </form>
  {/if}
</div>

<style>
  .verification-methods {
    display: grid;
    gap: var(--space-300);
  }

  .method-choices {
    display: grid;
    gap: var(--space-300);
  }

  .method-choices :global(.btn) {
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
    gap: var(--space-200);
  }

  .recovery-controls {
    display: grid;
    gap: var(--space-200);
    grid-template-columns: 1fr;
  }

  @media (width >= 42rem) {
    .recovery-controls {
      grid-template-columns: minmax(0, 1fr) auto;
    }
  }
</style>
