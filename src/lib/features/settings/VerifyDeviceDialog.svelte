<script lang="ts">
  import { Dialog } from 'bits-ui';
  import XIcon from 'phosphor-svelte/lib/XIcon';

  import type { RecoveryStateView } from '#src/generated/RecoveryStateView';
  import { i18n } from '#lib/i18n.js';
  import DialogFrame from '#lib/ui/primitives/DialogFrame.svelte';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import VerifyDeviceOptions from './VerifyDeviceOptions.svelte';

  interface Props {
    open?: boolean;
    recovery: RecoveryStateView;
    onVerified?: () => void | Promise<void>;
  }

  let { open = $bindable(false), recovery, onVerified }: Props = $props();

  function close(): void {
    open = false;
  }

  async function completeRecovery(): Promise<void> {
    close();
    await onVerified?.();
  }
</script>

<DialogFrame bind:open variant="verification">
  <div class="dialog-heading">
    <div>
      <Dialog.Title class="dialog-title">{$i18n.t('settings.verifyThisDevice')}</Dialog.Title>
      <Dialog.Description class="dialog-description">
        {$i18n.t('settings.chooseVerificationMethod')}
      </Dialog.Description>
    </div>
    <IconButton variant="ghost" size="small" label={$i18n.t('settings.close')} onclick={close}>
      <XIcon />
    </IconButton>
  </div>

  <VerifyDeviceOptions
    {recovery}
    inputId="settings-recovery-key"
    onRequested={close}
    onRecovered={completeRecovery}
  />
</DialogFrame>

<style>
  .dialog-heading {
    align-items: flex-start;
    display: flex;
    gap: var(--space-2);
    justify-content: space-between;
    margin-bottom: var(--space-3);
  }

  :global(.dialog-title),
  :global(.dialog-description) {
    margin: 0;
  }

  :global(.dialog-title) {
    font-size: var(--font-size-heading);
    font-weight: var(--font-weight-bold);
  }

  :global(.dialog-description) {
    color: var(--sable-surface-var-on-container);
    font-size: var(--font-size-small);
    margin-top: var(--space-1);
  }
</style>
