<script lang="ts">
  import { Dialog } from 'bits-ui';
  import CameraIcon from 'phosphor-svelte/lib/CameraIcon';
  import QrCodeIcon from 'phosphor-svelte/lib/QrCodeIcon';
  import { untrack } from 'svelte';

  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import { openExternalUrl } from '#lib/platform/external-links.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import DialogFrame from '#lib/ui/primitives/DialogFrame.svelte';
  import TextInput from '#lib/ui/primitives/TextInput.svelte';
  import VerificationQrCode from '#lib/features/settings/VerificationQrCode.svelte';
  import VerificationQrScanner from '#lib/features/settings/VerificationQrScanner.svelte';

  import { QrFlow, type QrLoginTarget, type QrMode } from './qr-flow.svelte.js';

  interface Props {
    open?: boolean;
    mode: QrMode;
    target?: QrLoginTarget;
    onSignedIn?: () => void;
  }

  let { open = $bindable(false), mode, target, onSignedIn }: Props = $props();

  const core = useCoreClient();
  const flow = new QrFlow(
    core,
    () => mode,
    () => target ?? null,
    () => onSignedIn?.()
  );
  const checkCodeId = $props.id();
  let checkCode = $state('');

  $effect(() => {
    if (!open) return;
    untrack(() => {
      flow.reset();
      checkCode = '';
    });
    return flow.listen();
  });

  let progress = $derived(flow.progress);
  let grant = $derived(mode === 'grant');
  let validCheckCode = $derived(/^\d{2}$/.test(checkCode));
  let title = $derived($i18n.t(grant ? 'qrLogin.titleGrant' : 'qrLogin.titleLogin'));
  let otherSide = $derived($i18n.t(grant ? 'qrLogin.signInWithQr' : 'qrLogin.linkDevice'));
  let inProgress = $derived(
    progress === null || (progress.stage !== 'done' && progress.stage !== 'failed')
  );

  let description = $derived.by(() => {
    if (flow.scanning) {
      return $i18n.t(grant ? 'qrLogin.scanHintGrant' : 'qrLogin.scanHintLogin', {
        action: otherSide,
      });
    }
    switch (progress?.stage) {
      case undefined:
        return $i18n.t(grant ? 'qrLogin.chooseGrant' : 'qrLogin.chooseLogin');
      case 'show_code':
        return $i18n.t(grant ? 'qrLogin.showHintGrant' : 'qrLogin.showHintLogin', {
          action: otherSide,
        });
      case 'enter_check_code':
        return $i18n.t('qrLogin.enterCheckCode');
      case 'show_check_code':
        return $i18n.t('qrLogin.showCheckCode');
      case 'waiting_for_token':
        return $i18n.t('qrLogin.waitingForToken');
      case 'waiting_for_auth':
        return $i18n.t('qrLogin.waitingForAuth');
      case 'done':
        return $i18n.t('qrLogin.doneGrant');
      default:
        return null;
    }
  });

  let announcement = $derived.by(() => {
    switch (progress?.stage) {
      case 'show_check_code':
        return $i18n.t('qrLogin.announceCheckCode', { code: progress.check_code });
      case 'waiting_for_token':
        return $i18n.t('qrLogin.announceUserCode', { code: progress.user_code });
      case 'waiting_for_auth':
        return $i18n.t('qrLogin.waiting');
      case 'starting':
        return $i18n.t('qrLogin.starting');
      case 'syncing_secrets':
      case 'signed_in':
        return $i18n.t(grant ? 'qrLogin.syncingGrant' : 'qrLogin.syncing');
      case 'done':
        return $i18n.t('qrLogin.doneGrant');
      case 'failed':
        return failureText(progress.reason);
      default:
        return '';
    }
  });

  function failureText(reason: string): string {
    return $i18n.t(
      reason === 'other' && grant ? 'qrLogin.failed.otherGrant' : `qrLogin.failed.${reason}`
    );
  }

  function close(): void {
    open = false;
  }

  function restart(): void {
    flow.reset();
    checkCode = '';
  }

  function focusOnMount(node: HTMLElement): void {
    node.focus();
  }
</script>

<DialogFrame
  {open}
  onOpenChange={(next) => {
    if (!next) close();
  }}
  variant="verification"
>
  <div class="qr-link">
    <Dialog.Title class="qr-title">{title}</Dialog.Title>
    {#if description}
      <Dialog.Description>
        {#snippet child({ props })}
          <p {...props} class="explain">{description}</p>
        {/snippet}
      </Dialog.Description>
    {/if}
    <p class="screen-reader-only" role="status">{announcement}</p>

    {#if flow.scanning}
      <div class="code">
        <VerificationQrScanner onScan={(data: Uint8Array) => void flow.scanned(data)} />
      </div>
      <div class="qr-actions">
        <Button class="qr-action" onclick={restart}>{$i18n.t('qrLogin.back')}</Button>
      </div>
    {:else if progress === null}
      <div class="qr-actions">
        <Button
          variant="primary"
          class="qr-action"
          disabled={flow.pending}
          onclick={() => void flow.showCode()}
        >
          <QrCodeIcon size={18} aria-hidden="true" />{$i18n.t('qrLogin.showCode')}
        </Button>
        <Button class="qr-action" disabled={flow.pending} onclick={() => flow.startScanning()}>
          <CameraIcon size={18} aria-hidden="true" />{$i18n.t('qrLogin.scanCode')}
        </Button>
      </div>
    {:else if progress.stage === 'show_code'}
      <div class="code">
        <VerificationQrCode code={progress.code} label={$i18n.t('qrLogin.codeLabel')} />
      </div>
    {:else if progress.stage === 'enter_check_code'}
      <form
        class="check-code"
        onsubmit={(event) => {
          event.preventDefault();
          if (validCheckCode) void flow.submitCheckCode(Number(checkCode));
        }}
      >
        <label class="screen-reader-only" for={checkCodeId}>
          {$i18n.t('qrLogin.checkCodeLabel')}
        </label>
        <TextInput
          id={checkCodeId}
          class="check-code-input"
          bind:value={checkCode}
          inputmode="numeric"
          autocomplete="off"
          enterkeyhint="done"
          pattern="[0-9]{'{2}'}"
          maxlength={2}
          {@attach focusOnMount}
        />
        <div class="qr-actions">
          <Button
            type="submit"
            variant="primary"
            class="qr-action"
            disabled={!validCheckCode || flow.pending}
          >
            {$i18n.t('qrLogin.confirm')}
          </Button>
        </div>
      </form>
    {:else if progress.stage === 'show_check_code'}
      <p class="digits" aria-hidden="true">{String(progress.check_code).padStart(2, '0')}</p>
    {:else if progress.stage === 'waiting_for_token'}
      <p class="digits" aria-hidden="true">{progress.user_code}</p>
      <p class="wait" aria-hidden="true">{$i18n.t('qrLogin.waiting')}</p>
    {:else if progress.stage === 'waiting_for_auth'}
      {@const uri = progress.verification_uri}
      <div class="qr-actions">
        <Button variant="primary" class="qr-action" onclick={() => void openExternalUrl(uri)}>
          {$i18n.t('qrLogin.openApproval')}
        </Button>
        <Button
          class="qr-action"
          disabled={flow.pending}
          onclick={() => void flow.continueGrant(true)}
        >
          {$i18n.t('qrLogin.approved')}
        </Button>
      </div>
    {:else if progress.stage === 'starting' || progress.stage === 'syncing_secrets' || progress.stage === 'signed_in'}
      <p class="wait" aria-hidden="true">{announcement}</p>
    {:else if progress.stage === 'done'}
      <div class="qr-actions">
        <Button variant="primary" class="qr-action" onclick={close}>
          {$i18n.t('qrLogin.close')}
        </Button>
      </div>
    {:else if progress.stage === 'failed'}
      <Alert variant="critical">{failureText(progress.reason)}</Alert>
      <div class="qr-actions">
        <Button variant="primary" class="qr-action" onclick={restart}>
          {$i18n.t('qrLogin.tryAgain')}
        </Button>
        <Button class="qr-action" onclick={close}>{$i18n.t('qrLogin.close')}</Button>
      </div>
    {/if}

    {#if inProgress}
      <Button variant="ghost" size="small" class="qr-action qr-cancel" onclick={close}>
        {$i18n.t('qrLogin.cancel')}
      </Button>
    {/if}
  </div>
</DialogFrame>

<style>
  .qr-link {
    display: grid;
    gap: var(--space-300);
    width: 100%;
  }

  :global(.qr-title) {
    font-size: var(--font-size-heading);
    font-weight: var(--font-weight-bold);
    margin: 0;
  }

  .explain {
    margin: 0;
  }

  .qr-actions {
    display: grid;
    gap: var(--space-200);
  }

  :global(.qr-action) {
    width: 100%;
  }

  :global(.qr-cancel) {
    margin-top: var(--space-200);
  }

  .code {
    display: grid;
    justify-items: center;
    margin: var(--space-300) 0 var(--space-400);
  }

  .check-code {
    display: grid;
    gap: var(--space-300);
  }

  .check-code :global(.check-code-input) {
    font-feature-settings: 'tnum';
    font-size: var(--font-size-heading);
    letter-spacing: 0.2em;
    text-align: center;
  }

  .digits {
    font-feature-settings: 'tnum';
    font-size: var(--font-size-display);
    font-weight: var(--font-weight-bold);
    letter-spacing: 0.1em;
    margin: 0;
    text-align: center;
  }

  .wait {
    margin: 0;
  }

  .wait::before {
    background: currentcolor;
    border-radius: 50%;
    content: '';
    display: inline-block;
    height: 0.55rem;
    margin-right: var(--space-200);
    width: 0.55rem;
  }

  @media (prefers-reduced-motion: no-preference) {
    :global(html:not([data-reduced-motion='on'])) .wait::before {
      animation: pulse 1.25s ease-in-out infinite;
    }
  }

  @keyframes pulse {
    50% {
      opacity: 0.3;
    }
  }

  @media (width >= 42rem) {
    .qr-link {
      width: min(26rem, calc(100vw - 3rem));
    }

    .qr-actions {
      display: flex;
      flex-wrap: wrap;
    }

    :global(.qr-action) {
      width: auto;
    }

    :global(.qr-cancel) {
      justify-self: start;
    }
  }
</style>
