<script lang="ts">
  import { Dialog } from 'bits-ui';
  import { uint8ArrayToBase64 } from 'uint8array-extras';

  import { useCoreClient } from '#lib/core/context.js';
  import { verificationErrorMessage } from '#lib/core/verification-errors.js';
  import { i18n } from '#lib/i18n.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import DialogFrame from '#lib/ui/primitives/DialogFrame.svelte';
  import VerificationQrCode from './VerificationQrCode.svelte';
  import VerificationQrScanner from './VerificationQrScanner.svelte';

  const NO_REPLY_DELAY_MS = 30_000;

  const core = useCoreClient();
  let activeFlow = $derived(
    core.verification ? JSON.stringify([core.verification.userId, core.verification.flowId]) : null
  );
  let error = $derived.by<string | null>(() => {
    void activeFlow;
    return null;
  });
  let scanning = $derived.by(() => {
    void activeFlow;
    return false;
  });
  let noReply = $derived.by(() => {
    void activeFlow;
    void core.verification?.state.phase;
    return false;
  });
  let choosing = $derived(core.verification?.state.phase === 'choose');
  let processingScan = $derived.by(() => {
    void activeFlow;
    void choosing;
    return false;
  });
  let scanMode = $derived(
    core.verification?.state.phase === 'choose' && core.verification.state.can_scan && scanning
  );
  let selfVerification = $derived(core.verification?.userId === core.session?.user_id);
  let title = $state<HTMLElement | null>(null);
  let shownPhase: string | undefined;
  const liveMessage = $derived.by(() => {
    const state = core.verification?.state;
    switch (state?.phase) {
      case 'requested':
        return state.initiated_by_us ? i18n.t('settings.waiting') : '';
      case 'reciprocated':
      case 'waiting':
      case 'confirmed':
        return i18n.t('settings.waiting');
      case 'choose':
        return processingScan ? i18n.t('settings.waiting') : '';
      case 'done':
        return i18n.t(
          selfVerification ? 'settings.verificationComplete' : 'settings.userVerificationComplete'
        );
      case 'cancelled':
        return i18n.t('settings.verificationCancelled', { reason: state.reason });
      default:
        return '';
    }
  });

  // This app-level component keeps verification events flowing even when no
  // route-specific feature currently subscribes to the core transport.
  $effect(() => core.subscribeEvents(() => {}));

  $effect(() => {
    const state = core.verification?.state;
    const waitingOnThem =
      state?.phase === 'waiting' || (state?.phase === 'requested' && state.initiated_by_us);
    if (!waitingOnThem) return;
    void activeFlow;
    const timer = setTimeout(() => (noReply = true), NO_REPLY_DELAY_MS);
    return () => clearTimeout(timer);
  });

  $effect(() => {
    const phase = core.verification?.state.phase;
    if (phase && shownPhase && phase !== shownPhase) title?.focus();
    shownPhase = phase;
  });

  async function accept(): Promise<void> {
    if (!core.verification) return;
    try {
      await core.rpc.encryption.acceptVerification({
        user_id: core.verification.userId,
        flow_id: core.verification.flowId,
      });
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
      await core.rpc.encryption.scanVerificationQr({
        user_id: flow.userId,
        flow_id: flow.flowId,
        data: uint8ArrayToBase64(data),
      });
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
      await core.rpc.encryption.startSasVerification({
        user_id: core.verification.userId,
        flow_id: core.verification.flowId,
      });
    } catch (cause) {
      error = verificationErrorMessage(cause);
    }
  }

  async function confirm(): Promise<void> {
    if (!core.verification) return;
    try {
      await core.rpc.encryption.confirmVerification({
        user_id: core.verification.userId,
        flow_id: core.verification.flowId,
      });
    } catch (cause) {
      error = verificationErrorMessage(cause);
    }
  }

  async function retry(): Promise<void> {
    const flow = core.verification;
    if (!flow) return;
    try {
      await core.rpc.encryption.cancelVerification({
        user_id: flow.userId,
        flow_id: flow.flowId,
        mismatch: false,
      });
      await core.requestVerification(flow.userId);
    } catch (cause) {
      error = verificationErrorMessage(cause);
    }
  }

  async function cancel(mismatch = false): Promise<void> {
    const flow = core.verification;
    if (!flow) return;
    try {
      await core.rpc.encryption.cancelVerification({
        user_id: flow.userId,
        flow_id: flow.flowId,
        mismatch,
      });
    } catch (cause) {
      error = verificationErrorMessage(cause);
    }
  }

  function handleOpenChange(next: boolean): void {
    if (next || !core.verification) return;
    const phase = core.verification.state.phase;
    if (phase !== 'done' && phase !== 'cancelled') void cancel();
    // Drop the flow on our own cancel too, or it outlives the dialog and blocks a new request.
    core.verification = null;
  }
</script>

<DialogFrame
  open={core.verification !== null}
  onOpenChange={handleOpenChange}
  variant="verification"
>
  <Dialog.Title class="verification-title" tabindex={-1} bind:ref={title}>
    {i18n.t(selfVerification ? 'settings.verification' : 'settings.userVerification')}
  </Dialog.Title>
  <p class="visually-hidden" role="status">{liveMessage}</p>
  {#if core.verification}
    {#if core.verification.state.phase === 'requested'}
      {#if core.verification.state.initiated_by_us}
        <Dialog.Description class="verification-description">
          {i18n.t(selfVerification ? 'settings.acceptOtherDevice' : 'settings.acceptOtherUser')}
        </Dialog.Description>
        <p class="verification-wait" aria-hidden="true">{i18n.t('settings.waiting')}</p>
        {#if noReply}
          <Button class="verification-action" onclick={() => void retry()}
            >{i18n.t('settings.verificationRetry')}</Button
          >
        {/if}
      {:else}
        <Dialog.Description class="verification-description">
          {i18n.t(
            selfVerification
              ? 'settings.verificationRequested'
              : 'settings.userVerificationRequested'
          )}
        </Dialog.Description>
        <Button variant="primary" class="verification-action" onclick={accept}
          >{i18n.t('settings.acceptVerification')}</Button
        >
      {/if}
    {:else if core.verification.state.phase === 'choose' && processingScan}
      <Dialog.Description class="verification-description">
        {i18n.t('settings.finishing')}
      </Dialog.Description>
      <p class="verification-wait" aria-hidden="true">{i18n.t('settings.waiting')}</p>
    {:else if core.verification.state.phase === 'choose'}
      {@const choice = core.verification.state}
      <Dialog.Description class="verification-description">
        {i18n.t(
          scanMode
            ? 'settings.verificationScanTheirs'
            : choice.qr
              ? 'settings.verificationShowOurs'
              : 'settings.chooseVerificationMethod'
        )}
      </Dialog.Description>
      {#if scanMode || choice.qr}
        <div class="verification-code">
          {#if scanMode}
            <VerificationQrScanner onScan={(data: Uint8Array) => void scanned(data)} />
          {:else if choice.qr}
            <VerificationQrCode code={choice.qr} label={i18n.t('settings.verificationQrLabel')} />
          {/if}
        </div>
      {/if}
      <div class="verification-actions">
        {#if choice.can_scan && choice.qr}
          <Button class="verification-action" onclick={() => (scanning = !scanMode)}>
            {i18n.t(scanMode ? 'settings.showOurCode' : 'settings.scanTheirCode')}
          </Button>
        {:else if choice.can_scan && !scanMode}
          <Button class="verification-action" onclick={() => (scanning = true)}>
            {i18n.t('settings.scanWithCamera')}
          </Button>
        {/if}
        {#if choice.can_compare}
          <Button class="verification-action" onclick={() => void compareEmoji()}>
            {i18n.t('settings.compareEmojiInstead')}
          </Button>
        {/if}
      </div>
    {:else if core.verification.state.phase === 'scanned'}
      <Dialog.Description class="verification-description">
        {i18n.t('settings.verificationScannedPrompt')}
      </Dialog.Description>
      <div class="verification-actions">
        <Button variant="primary" class="verification-action" onclick={confirm}>
          {i18n.t('settings.verificationScannedYes')}
        </Button>
        <Button
          variant="danger"
          size="small"
          class="verification-action"
          onclick={() => void cancel(true)}>{i18n.t('settings.verificationScannedNo')}</Button
        >
      </div>
    {:else if core.verification.state.phase === 'reciprocated'}
      <Dialog.Description class="verification-description">
        {i18n.t('settings.verificationScanSucceeded')}
      </Dialog.Description>
      <p class="verification-wait" aria-hidden="true">{i18n.t('settings.waiting')}</p>
    {:else if core.verification.state.phase === 'waiting'}
      <Dialog.Description class="verification-description">
        {i18n.t('settings.startingEmojiComparison')}
      </Dialog.Description>
      <p class="verification-wait" aria-hidden="true">{i18n.t('settings.waiting')}</p>
      {#if noReply}
        <Button class="verification-action" onclick={() => void retry()}
          >{i18n.t('settings.verificationRetry')}</Button
        >
      {/if}
    {:else if core.verification.state.phase === 'compare'}
      <Dialog.Description class="verification-description">
        {i18n.t('settings.compareEmoji')}
      </Dialog.Description>
      <div class="emoji" role="group" aria-label={i18n.t('settings.verificationEmoji')}>
        {#each core.verification.state.emojis as emoji, index (index)}
          <div class="emoji-item" role="group" aria-label={emoji.description}>
            <span aria-hidden="true">{emoji.symbol}</span>
            <small aria-hidden="true">{emoji.description}</small>
          </div>
        {/each}
      </div>
      <p class="decimals">{core.verification.state.decimals.join(' · ')}</p>
      <div class="verification-actions">
        <Button variant="primary" class="verification-action" onclick={confirm}
          >{i18n.t('settings.theyMatch')}</Button
        >
        <Button
          variant="danger"
          size="small"
          class="verification-action"
          onclick={() => void cancel(true)}>{i18n.t('settings.theyDoNotMatch')}</Button
        >
      </div>
    {:else if core.verification.state.phase === 'confirmed'}
      <Dialog.Description class="verification-description">
        {i18n.t('settings.finishing')}
      </Dialog.Description>
      <p class="verification-wait" aria-hidden="true">{i18n.t('settings.waiting')}</p>
    {:else if core.verification.state.phase === 'done'}
      <Dialog.Description class="verification-description">
        {i18n.t(
          selfVerification ? 'settings.verificationComplete' : 'settings.userVerificationComplete'
        )}
      </Dialog.Description>
      <Button
        variant="primary"
        class="verification-action"
        onclick={() => (core.verification = null)}>{i18n.t('common.close')}</Button
      >
    {:else if core.verification.state.phase === 'cancelled'}
      <Dialog.Description class="verification-description">
        {i18n.t('settings.verificationCancelled', { reason: core.verification.state.reason })}
      </Dialog.Description>
      <Button
        variant="primary"
        class="verification-action"
        onclick={() => (core.verification = null)}>{i18n.t('common.close')}</Button
      >
    {/if}
    {#if error}<Alert variant="critical" role="alert">{error}</Alert>{/if}
    {#if core.verification.state.phase !== 'done' && core.verification.state.phase !== 'cancelled'}
      <Button
        variant="ghost"
        size="small"
        class="verification-action verification-cancel"
        onclick={() => void cancel()}>{i18n.t('settings.cancelVerification')}</Button
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

  .visually-hidden {
    block-size: 1px;
    clip-path: inset(50%);
    inline-size: 1px;
    overflow: hidden;
    position: absolute;
    white-space: nowrap;
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
