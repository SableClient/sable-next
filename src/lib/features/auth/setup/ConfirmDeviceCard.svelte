<script lang="ts">
  import ArrowLeftIcon from 'phosphor-svelte/lib/ArrowLeftIcon';
  import DevicesIcon from 'phosphor-svelte/lib/DevicesIcon';
  import KeyIcon from 'phosphor-svelte/lib/KeyIcon';
  import { untrack } from 'svelte';

  import { useCoreClient } from '#lib/core/context.js';
  import { DeviceVerification } from '#lib/core/device-verification.svelte.js';
  import { IdentityReset } from '#lib/core/identity-reset.svelte.js';
  import { i18n } from '#lib/i18n.js';
  import { openExternalAuthUrl } from '#lib/platform/external-auth.js';
  import { afterOverlayPops, holdOverlayBack } from '#lib/platform/overlay-back.svelte.js';
  import Button from '#lib/ui/primitives/Button.svelte';
  import FormField from '#lib/ui/primitives/FormField.svelte';
  import Spinner from '#lib/ui/primitives/Spinner.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';
  import AuthField from '../shared/AuthField.svelte';
  import AuthInfoBox from '../shared/AuthInfoBox.svelte';
  import AuthSecondaryAction from '../shared/AuthSecondaryAction.svelte';
  import AuthStatusSlot from '../shared/AuthStatusSlot.svelte';

  interface Props {
    onComplete: () => void;
    onSkip: () => void;
    onReset: (recoveryKey: string) => void;
  }

  let { onComplete, onSkip, onReset }: Props = $props();
  const core = useCoreClient();
  const verification = new DeviceVerification(core);
  let reset = $state(new IdentityReset(core));
  let view = $state<'choices' | 'recovery' | 'reset' | 'skip'>('choices');
  let understood = $state(false);
  let prompted = $state(false);

  const status = $derived(core.encryption);
  const verified = $derived(status?.verification === 'verified');
  const passphrase = $derived(status?.recovery_passphrase ?? false);
  const canUseRecovery = $derived(status !== null && status.recovery !== 'disabled');
  const canUseAnotherDevice = $derived(
    core.deviceList.some((device) => !device.is_own && device.cross_signed)
  );
  const resetOnly = $derived(!canUseRecovery && !canUseAnotherDevice);

  holdOverlayBack(
    () => view !== 'choices' && !verified,
    () => {
      leaveView();
    }
  );

  $effect(() => {
    if (!status || status.verification === 'unknown') return;
    if (status.verification === 'verified' && !reset.busy) {
      untrack(leaveView);
      if (!untrack(() => prompted)) onComplete();
    }
    prompted = true;
  });

  function leaveView(): void {
    if (view === 'choices') return;
    if (view === 'reset') void reset.cancel();
    reset = new IdentityReset(core);
    understood = false;
    verification.error = null;
    view = 'choices';
  }

  async function runReset(step: () => Promise<void>): Promise<void> {
    const running = reset;
    await step();
    if (running.phase !== 'done' || !running.recoveryKey) return;
    const recoveryKey = running.recoveryKey;
    leaveView();
    await afterOverlayPops();
    onReset(recoveryKey);
  }

  async function skip(): Promise<void> {
    leaveView();
    await afterOverlayPops();
    onSkip();
  }

  function approve(): void {
    if (!reset.approvalUrl) return;
    void openExternalAuthUrl(reset.approvalUrl);
    void runReset(() => reset.awaitApproval());
  }
</script>

{#snippet backButton()}
  <Button class="confirm-device-back" variant="ghost" size="small" onclick={leaveView}>
    <ArrowLeftIcon aria-hidden="true" />
    {$i18n.t('setup.back')}
  </Button>
{/snippet}

<div class="confirm-device-card auth-card-surface">
  {#if !prompted}
    <AuthField labelId="confirm-device-title" label={$i18n.t('setup.confirmTitle')}>
      <AuthInfoBox><Spinner small />{$i18n.t('setup.checking')}</AuthInfoBox>
    </AuthField>
  {:else if verified && !reset.busy}
    <AuthField labelId="confirm-device-title" label={$i18n.t('setup.confirmedTitle')}>
      <AuthInfoBox>{$i18n.t('setup.confirmedDescription')}</AuthInfoBox>
    </AuthField>
    <AuthStatusSlot />
    <Button variant="primary" block onclick={onComplete}>{$i18n.t('auth.continue')}</Button>
  {:else if view === 'recovery'}
    {@render backButton()}
    <form
      class="confirm-device-form"
      aria-labelledby="confirm-device-title"
      onsubmit={(event) => {
        event.preventDefault();
        void verification.recoverIdentity(undefined, passphrase);
      }}
    >
      <h2 id="confirm-device-title" class="confirm-device-heading">
        {$i18n.t('setup.confirmTitle')}
      </h2>
      <FormField
        dense
        fieldId="setup-recovery-key"
        label={$i18n.t(passphrase ? 'settings.recoveryKeyOrPassphrase' : 'settings.recoveryKey')}
      >
        <TextInput
          id="setup-recovery-key"
          bind:value={verification.recoveryKey}
          autocomplete="off"
          autocapitalize="none"
          disabled={verification.recovering}
          autofocus
          spellcheck={false}
          type="password"
          placeholder={$i18n.t(
            passphrase
              ? 'settings.recoveryKeyOrPassphrasePlaceholder'
              : 'settings.recoveryKeyPlaceholder'
          )}
        />
      </FormField>
      <AuthStatusSlot message={verification.error} />
      <Button
        type="submit"
        variant="primary"
        block
        loading={verification.recovering}
        disabled={!verification.recoveryKey.trim()}
      >
        {$i18n.t('auth.continue')}
      </Button>
    </form>
  {:else if view === 'reset'}
    {@render backButton()}
    <AuthField labelId="confirm-device-title" label={$i18n.t('setup.resetTitle')}>
      {#if reset.phase === 'password'}
        <form
          class="confirm-device-form"
          aria-labelledby="confirm-device-title"
          onsubmit={(event) => {
            event.preventDefault();
            void runReset(() => reset.submitPassword());
          }}
        >
          <FormField dense fieldId="setup-reset-password" label={$i18n.t('setup.resetPassword')}>
            <TextInput
              id="setup-reset-password"
              type="password"
              bind:value={reset.password}
              autocomplete="current-password"
              disabled={reset.busy}
              autofocus
            />
          </FormField>
          <AuthStatusSlot message={reset.error} />
          <Button
            type="submit"
            variant="danger"
            block
            loading={reset.busy}
            disabled={!reset.password}
          >
            {$i18n.t('setup.resetAction')}
          </Button>
        </form>
      {:else if reset.phase === 'approve'}
        <AuthInfoBox>{$i18n.t('setup.resetApprove')}</AuthInfoBox>
        <AuthStatusSlot
          loading={reset.busy}
          loadingMessage={$i18n.t('setup.resetWaiting')}
          message={reset.error}
        />
        <Button variant="danger" block disabled={reset.busy} onclick={approve}>
          {$i18n.t('setup.resetOpenApproval')}
        </Button>
      {:else}
        <AuthInfoBox>
          <div class="confirm-device-reset-copy">
            <p>{$i18n.t('setup.resetWhen')}</p>
            <ul>
              <li>{$i18n.t('setup.resetHistory')}</li>
              <li>{$i18n.t('setup.resetContacts')}</li>
            </ul>
          </div>
        </AuthInfoBox>
        <label class="confirm-device-understood">
          <input type="checkbox" bind:checked={understood} disabled={reset.busy} />
          {$i18n.t('setup.resetUnderstood')}
        </label>
        <AuthStatusSlot message={reset.error} />
        <Button
          variant="danger"
          block
          loading={reset.busy}
          disabled={!understood}
          onclick={() => void runReset(() => reset.start())}
        >
          {$i18n.t('setup.resetAction')}
        </Button>
      {/if}
    </AuthField>
  {:else if view === 'skip'}
    <AuthField labelId="confirm-device-title" label={$i18n.t('setup.skipTitle')}>
      <AuthInfoBox>{$i18n.t('setup.skipBody')}</AuthInfoBox>
    </AuthField>
    <AuthStatusSlot />
    <div class="confirm-device-actions">
      <Button variant="primary" block onclick={leaveView}>
        {$i18n.t('setup.keepConfirming')}
      </Button>
      <Button block onclick={() => void skip()}>{$i18n.t('setup.skipAnyway')}</Button>
    </div>
  {:else}
    <AuthField labelId="confirm-device-title" label={$i18n.t('setup.confirmTitle')}>
      <AuthInfoBox>
        {$i18n.t(resetOnly ? 'setup.confirmDescriptionResetOnly' : 'setup.confirmDescription')}
      </AuthInfoBox>
    </AuthField>
    <AuthStatusSlot message={verification.error} />
    <div class="confirm-device-actions">
      {#if canUseAnotherDevice}
        <Button
          block
          loading={verification.requesting}
          onclick={() => void verification.requestVerification()}
        >
          <DevicesIcon aria-hidden="true" />
          {$i18n.t('setup.useAnotherDevice')}
        </Button>
      {/if}
      {#if canUseRecovery}
        <Button block onclick={() => (view = 'recovery')}>
          <KeyIcon aria-hidden="true" />
          {$i18n.t(passphrase ? 'setup.useRecoveryKeyOrPassphrase' : 'setup.useRecoveryKey')}
        </Button>
      {/if}
      {#if resetOnly}
        <Button variant="danger" block onclick={() => (view = 'reset')}>
          {$i18n.t('setup.resetAction')}
        </Button>
      {/if}
    </div>
  {/if}
</div>

{#if prompted && !verified && view === 'choices'}
  {#if !resetOnly}
    <AuthSecondaryAction label={$i18n.t('setup.cantConfirm')} onclick={() => (view = 'reset')} />
  {/if}
  <AuthSecondaryAction label={$i18n.t('auth.skipForNow')} onclick={() => (view = 'skip')} />
{/if}

<style>
  .confirm-device-card {
    min-width: 0;
  }

  .confirm-device-form,
  .confirm-device-actions {
    display: grid;
    gap: var(--space-300);
  }

  .confirm-device-actions :global(.btn:has(svg)) {
    justify-content: flex-start;
  }

  .confirm-device-actions :global(svg),
  :global(.confirm-device-back svg) {
    flex: 0 0 auto;
    height: var(--icon-size-medium);
    width: var(--icon-size-medium);
  }

  :global(.confirm-device-back) {
    justify-self: start;
  }

  .confirm-device-heading {
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-medium);
    line-height: var(--line-height-heading);
    margin: 0;
  }

  .confirm-device-reset-copy {
    display: grid;
    gap: var(--space-200);
  }

  .confirm-device-reset-copy p,
  .confirm-device-reset-copy ul {
    margin: 0;
  }

  .confirm-device-reset-copy ul {
    display: grid;
    gap: var(--space-100);
    padding-inline-start: var(--space-400);
  }

  .confirm-device-understood {
    align-items: center;
    display: flex;
    font-size: var(--font-size-small);
    gap: var(--space-200);
  }
</style>
