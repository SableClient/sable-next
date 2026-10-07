<script lang="ts">
  import { Dialog } from 'bits-ui';
  import { onMount } from 'svelte';
  import { uint8ArrayToBase64 } from 'uint8array-extras';

  import { useCoreClient } from '#lib/core/context.js';
  import { verificationErrorMessage } from '#lib/core/verification-errors.js';
  import { i18n } from '#lib/i18n.js';
  import { isNativeMobile } from '#lib/platform/os.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import DialogFrame from '#lib/ui/primitives/DialogFrame.svelte';
  import VerificationQrCode from './VerificationQrCode.svelte';
  import VerificationQrScanner from './VerificationQrScanner.svelte';

  const core = useCoreClient();
  let error = $state<string | null>(null);
  let scanning = $state<boolean | null>(null);
  let prefersScan = $state(isNativeMobile());
  let processingScan = $state(false);
  let activeFlow = $state<string | null>(null);
  let scanMode = $derived(
    core.verification?.state.phase === 'choose' &&
      core.verification.state.can_scan &&
      (scanning ?? prefersScan)
  );
  let selfVerification = $derived(core.verification?.userId === core.session?.user_id);

  // This app-level component keeps verification events flowing even when no
  // route-specific feature currently subscribes to the core transport.
  $effect(() => core.subscribeEvents(() => {}));

  $effect(() => {
    const flow = core.verification;
    const key = flow ? JSON.stringify([flow.userId, flow.flowId]) : null;
    if (key === activeFlow) return;
    activeFlow = key;
    scanning = null;
    processingScan = false;
    error = null;
  });

  $effect(() => {
    if (core.verification?.state.phase !== 'choose') processingScan = false;
  });

  onMount(() => {
    if (prefersScan || !window.matchMedia('(pointer: coarse)').matches) return;
    void navigator.mediaDevices?.enumerateDevices().then(
      (devices) => {
        prefersScan = devices.some((device) => device.kind === 'videoinput');
      },
      () => {}
    );
  });

  async function accept(): Promise<void> {
    if (!core.verification) return;
    try {
      await core.commands.acceptVerification(core.verification.userId, core.verification.flowId);
    } catch (cause) {
      error = verificationErrorMessage(cause);
    }
  }

  async function scanned(data: Uint8Array): Promise<void> {
    const flow = core.verification;
    if (!flow || processingScan) return;
    processingScan = true;
    error = null;
    try {
      await core.commands.scanVerificationQr(flow.userId, flow.flowId, uint8ArrayToBase64(data));
    } catch (cause) {
      if (core.verification?.userId === flow.userId && core.verification.flowId === flow.flowId) {
        processingScan = false;
        error = verificationErrorMessage(cause);
      }
    }
  }

  async function compareEmoji(): Promise<void> {
    if (!core.verification) return;
    try {
      await core.commands.startSasVerification(core.verification.userId, core.verification.flowId);
    } catch (cause) {
      error = verificationErrorMessage(cause);
    }
  }

  async function confirm(): Promise<void> {
    if (!core.verification) return;
    try {
      await core.commands.confirmVerification(core.verification.userId, core.verification.flowId);
    } catch (cause) {
      error = verificationErrorMessage(cause);
    }
  }

  async function cancel(mismatch = false): Promise<void> {
    const flow = core.verification;
    if (!flow) return;
    try {
      await core.commands.cancelVerification(flow.userId, flow.flowId, mismatch);
    } catch (cause) {
      error = verificationErrorMessage(cause);
    }
  }

  function handleOpenChange(next: boolean): void {
    if (next || !core.verification) return;
    const phase = core.verification.state.phase;
    if (phase !== 'done' && phase !== 'cancelled') void cancel();
    // Drop the flow even when we cancel it ourselves, otherwise the flow
    // outlives the dismissed dialog and a fresh verification request can't
    // reopen the panel.
    core.verification = null;
  }
</script>

<DialogFrame
  open={core.verification !== null}
  onOpenChange={handleOpenChange}
  variant="verification"
>
  <Dialog.Title class="verification-title">
    {$i18n.t(selfVerification ? 'settings.verification' : 'settings.userVerification')}
  </Dialog.Title>
  {#if core.verification}
    {#if core.verification.state.phase === 'requested'}
      {#if core.verification.state.initiated_by_us}
        <Dialog.Description class="verification-description">
          {$i18n.t(selfVerification ? 'settings.acceptOtherDevice' : 'settings.acceptOtherUser')}
        </Dialog.Description>
        <p class="verification-wait" role="status">{$i18n.t('settings.waiting')}</p>
      {:else}
        <Dialog.Description class="verification-description">
          {$i18n.t(
            selfVerification
              ? 'settings.verificationRequested'
              : 'settings.userVerificationRequested'
          )}
        </Dialog.Description>
        <Button variant="primary" class="verification-action" onclick={accept}
          >{$i18n.t('settings.acceptVerification')}</Button
        >
      {/if}
    {:else if core.verification.state.phase === 'choose' && processingScan}
      <Dialog.Description class="verification-description">
        {$i18n.t('settings.finishing')}
      </Dialog.Description>
      <p class="verification-wait" role="status">{$i18n.t('settings.waiting')}</p>
    {:else if core.verification.state.phase === 'choose'}
      {@const choice = core.verification.state}
      <Dialog.Description class="verification-description">
        {$i18n.t(
          scanMode || !choice.qr
            ? 'settings.verificationScanTheirs'
            : 'settings.verificationShowOurs'
        )}
      </Dialog.Description>
      <div class="verification-code">
        {#if scanMode || !choice.qr}
          <VerificationQrScanner onScan={(data: Uint8Array) => void scanned(data)} />
        {:else}
          <VerificationQrCode code={choice.qr} label={$i18n.t('settings.verificationQrLabel')} />
        {/if}
      </div>
      <div class="verification-actions">
        {#if choice.can_scan && choice.qr}
          <Button class="verification-action" onclick={() => (scanning = !scanMode)}>
            {$i18n.t(scanMode ? 'settings.showOurCode' : 'settings.scanTheirCode')}
          </Button>
        {/if}
        {#if choice.can_compare}
          <Button class="verification-action" onclick={() => void compareEmoji()}>
            {$i18n.t('settings.compareEmojiInstead')}
          </Button>
        {/if}
      </div>
    {:else if core.verification.state.phase === 'scanned'}
      <Dialog.Description class="verification-description">
        {$i18n.t('settings.verificationScannedPrompt')}
      </Dialog.Description>
      <div class="verification-actions">
        <Button variant="primary" class="verification-action" onclick={confirm}>
          {$i18n.t('settings.verificationScannedYes')}
        </Button>
        <Button
          variant="danger"
          size="small"
          class="verification-action"
          onclick={() => void cancel(true)}>{$i18n.t('settings.verificationScannedNo')}</Button
        >
      </div>
    {:else if core.verification.state.phase === 'reciprocated'}
      <Dialog.Description class="verification-description">
        {$i18n.t('settings.verificationScanSucceeded')}
      </Dialog.Description>
      <p class="verification-wait" role="status">{$i18n.t('settings.waiting')}</p>
    {:else if core.verification.state.phase === 'waiting'}
      <Dialog.Description class="verification-description">
        {$i18n.t('settings.startingEmojiComparison')}
      </Dialog.Description>
      <p class="verification-wait" role="status">{$i18n.t('settings.waiting')}</p>
    {:else if core.verification.state.phase === 'compare'}
      <Dialog.Description class="verification-description">
        {$i18n.t('settings.compareEmoji')}
      </Dialog.Description>
      <div class="emoji" aria-label={$i18n.t('settings.verificationEmoji')}>
        {#each core.verification.state.emojis as emoji, index (index)}
          <div class="emoji-item">
            <span>{emoji.symbol}</span>
            <small>{emoji.description}</small>
          </div>
        {/each}
      </div>
      <p class="decimals">{core.verification.state.decimals.join(' · ')}</p>
      <div class="verification-actions">
        <Button variant="primary" class="verification-action" onclick={confirm}
          >{$i18n.t('settings.theyMatch')}</Button
        >
        <Button
          variant="danger"
          size="small"
          class="verification-action"
          onclick={() => void cancel(true)}>{$i18n.t('settings.theyDoNotMatch')}</Button
        >
      </div>
    {:else if core.verification.state.phase === 'confirmed'}
      <Dialog.Description class="verification-description">
        {$i18n.t('settings.finishing')}
      </Dialog.Description>
      <p class="verification-wait" role="status">{$i18n.t('settings.waiting')}</p>
    {:else if core.verification.state.phase === 'done'}
      <Dialog.Description class="verification-description">
        {$i18n.t(
          selfVerification ? 'settings.verificationComplete' : 'settings.userVerificationComplete'
        )}
      </Dialog.Description>
      <Button
        variant="primary"
        class="verification-action"
        onclick={() => (core.verification = null)}>{$i18n.t('common.close')}</Button
      >
    {:else if core.verification.state.phase === 'cancelled'}
      <Dialog.Description class="verification-description">
        {$i18n.t('settings.verificationCancelled', { reason: core.verification.state.reason })}
      </Dialog.Description>
      <Button
        variant="primary"
        class="verification-action"
        onclick={() => (core.verification = null)}>{$i18n.t('common.close')}</Button
      >
    {/if}
    {#if error}<Alert variant="critical" role="alert">{error}</Alert>{/if}
    {#if core.verification.state.phase !== 'done' && core.verification.state.phase !== 'cancelled'}
      <Button
        variant="ghost"
        size="small"
        class="verification-action verification-cancel"
        onclick={() => void cancel()}>{$i18n.t('settings.cancelVerification')}</Button
      >
    {/if}
  {/if}
</DialogFrame>

<style>
  :global(.verification-title) {
    font-size: var(--font-size-heading);
    font-weight: var(--font-weight-bold);
    margin: 0;
  }

  :global(.verification-description) {
    margin-bottom: var(--space-300);
  }

  .emoji {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-300);
    margin: var(--space-400) 0;
  }

  .emoji-item {
    align-items: center;
    display: flex;
    flex: 1 1 4.5rem;
    flex-direction: column;
    gap: var(--space-100);
    text-align: center;
  }

  .emoji-item span {
    font-size: var(--font-size-emoji-display);
    line-height: 1;
  }

  .emoji-item small {
    color: var(--surface-var-on-container);
  }

  .verification-actions {
    display: grid;
    gap: var(--space-200);
  }

  .verification-code {
    display: grid;
    gap: var(--space-200);
    justify-items: center;
    margin: var(--space-300) 0 var(--space-400);
  }

  :global(.verification-action) {
    width: 100%;
  }

  :global(.verification-cancel) {
    margin-top: var(--space-200);
  }

  .verification-wait::before {
    background: currentcolor;
    border-radius: 50%;
    content: '';
    display: inline-block;
    height: 0.55rem;
    margin-right: var(--space-200);
    width: 0.55rem;
  }

  @media (prefers-reduced-motion: no-preference) {
    :global(html:not([data-reduced-motion='on'])) .verification-wait::before {
      animation: pulse 1.25s ease-in-out infinite;
    }
  }

  .decimals {
    font-feature-settings: 'tnum';
    font-weight: var(--font-weight-bold);
  }

  @keyframes pulse {
    50% {
      opacity: 0.3;
    }
  }

  @media (width >= 42rem) {
    .verification-actions {
      display: flex;
    }

    :global(.verification-action) {
      width: auto;
    }
  }
</style>
