<script lang="ts">
  import { Dialog } from 'bits-ui';

  import { useCoreClient } from '#lib/core/context.js';
  import { IdentityReset } from '#lib/core/identity-reset.svelte.js';
  import { openExternalAuthUrl } from '#lib/platform/external-auth.js';
  import { i18n } from '#lib/i18n.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import DialogActions from '#lib/ui/primitives/DialogActions.svelte';
  import DialogFrame from '#lib/ui/primitives/DialogFrame.svelte';
  import Label from '#lib/ui/primitives/Label.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';

  interface Props {
    open?: boolean;
    onReset?: () => void | Promise<void>;
  }

  let { open = $bindable(false), onReset }: Props = $props();
  const core = useCoreClient();
  let reset = $state(new IdentityReset(core));
  let understood = $state(false);

  function dismiss(): void {
    void reset.cancel();
    if (reset.phase === 'done') void onReset?.();
    reset = new IdentityReset(core);
    understood = false;
  }

  function close(): void {
    dismiss();
    open = false;
  }

  function approve(): void {
    if (!reset.approvalUrl) return;
    void openExternalAuthUrl(reset.approvalUrl);
    void reset.awaitApproval();
  }

  function submit(): void {
    if (reset.phase === 'confirm') void reset.start();
    else if (reset.phase === 'password') void reset.submitPassword();
    else if (reset.phase === 'done') close();
  }
</script>

<DialogFrame
  bind:open
  variant="verification"
  label={$i18n.t('settings.resetIdentityTitle')}
  onOpenChange={(next) => {
    if (!next) dismiss();
  }}
  onConfirm={submit}
>
  <div class="reset-identity">
    {#if reset.phase === 'done'}
      <Dialog.Title class="reset-identity-title">{$i18n.t('settings.saveRecoveryKey')}</Dialog.Title
      >
      <p>{$i18n.t('settings.saveRecoveryKeyDescription')}</p>
      <code>{reset.recoveryKey}</code>
    {:else}
      <Dialog.Title class="reset-identity-title"
        >{$i18n.t('settings.resetIdentityTitle')}</Dialog.Title
      >
      {#if reset.phase === 'confirm'}
        <p>{$i18n.t('settings.resetIdentityWhen')}</p>
        <ul>
          <li>{$i18n.t('settings.resetIdentityHistory')}</li>
          <li>{$i18n.t('settings.resetIdentityReverify')}</li>
        </ul>
        <label class="understood">
          <input type="checkbox" bind:checked={understood} disabled={reset.busy} />
          {$i18n.t('settings.resetIdentityUnderstood')}
        </label>
      {:else if reset.phase === 'password'}
        <Label for="reset-identity-password">{$i18n.t('settings.resetIdentityPassword')}</Label>
        <TextInput
          id="reset-identity-password"
          type="password"
          bind:value={reset.password}
          autocomplete="current-password"
          disabled={reset.busy}
          autofocus
        />
      {:else}
        <p>{$i18n.t('settings.resetIdentityApprove')}</p>
      {/if}
    {/if}

    {#if reset.error}<Alert variant="critical" role="alert">{reset.error}</Alert>{/if}

    <DialogActions>
      {#if reset.phase === 'done'}
        <Button type="submit">{$i18n.t('settings.savedRecoveryKey')}</Button>
      {:else}
        <Button type="button" variant="ghost" onclick={close}>{$i18n.t('settings.cancel')}</Button>
        {#if reset.phase === 'approve'}
          <Button type="button" variant="danger" loading={reset.busy} onclick={approve}>
            {$i18n.t('settings.resetIdentityOpenApproval')}
          </Button>
        {:else}
          <Button
            type="submit"
            variant="danger"
            loading={reset.busy}
            disabled={reset.phase === 'confirm' ? !understood : !reset.password}
          >
            {$i18n.t('settings.resetIdentity')}
          </Button>
        {/if}
      {/if}
    </DialogActions>
  </div>
</DialogFrame>

<style>
  .reset-identity {
    display: grid;
    gap: var(--space-300);
    width: min(28rem, calc(100vw - 2rem));
  }

  :global(.reset-identity-title) {
    font-size: var(--font-size-heading);
    font-weight: var(--font-weight-bold);
    margin: 0;
  }

  .reset-identity p,
  .reset-identity ul {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    margin: 0;
  }

  .reset-identity ul {
    display: grid;
    gap: var(--space-100);
    padding-inline-start: var(--space-400);
  }

  .reset-identity code {
    overflow-wrap: anywhere;
    user-select: all;
  }

  .understood {
    align-items: center;
    display: flex;
    font-size: var(--font-size-small);
    gap: var(--space-200);
  }
</style>
