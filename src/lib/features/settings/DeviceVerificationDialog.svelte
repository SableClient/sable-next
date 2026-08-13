<script lang="ts">
  import { Dialog } from 'bits-ui';

  import { CoreError } from '@/transport';
  import { useCoreClient } from '$lib/core/context';
  import { i18n, t } from '$lib/i18n';
  import Alert from '$lib/ui/primitives/Alert.svelte';
  import Button from '$lib/ui/primitives/Button.svelte';
  import DialogFrame from '$lib/ui/primitives/DialogFrame.svelte';

  const core = useCoreClient();
  let error = $state<string | null>(null);

  // This app-level component keeps verification events flowing even when no
  // route-specific feature currently subscribes to the core transport.
  $effect(() => core.subscribeEvents(() => {}));

  function messageFor(cause: unknown): string {
    if (cause instanceof CoreError && cause.detail.code === 'unavailable') {
      return t('settings.verificationUnavailable');
    }
    return t('settings.actionFailed');
  }

  async function accept(): Promise<void> {
    if (!core.verification || !core.session?.user_id) return;
    try {
      await core.acceptVerification(core.session.user_id, core.verification.flowId);
    } catch (cause) {
      error = messageFor(cause);
    }
  }

  async function confirm(): Promise<void> {
    if (!core.verification || !core.session?.user_id) return;
    try {
      await core.confirmVerification(core.session.user_id, core.verification.flowId);
    } catch (cause) {
      error = messageFor(cause);
    }
  }

  async function cancel(mismatch = false): Promise<void> {
    if (!core.verification || !core.session?.user_id) return;
    try {
      await core.cancelVerification(core.session.user_id, core.verification.flowId, mismatch);
    } catch (cause) {
      error = messageFor(cause);
    }
  }

  function handleOpenChange(next: boolean): void {
    if (next || !core.verification) return;
    if (core.verification.state.phase === 'done' || core.verification.state.phase === 'cancelled') {
      core.verification = null;
    } else {
      void cancel();
    }
  }
</script>

<DialogFrame
  open={core.verification !== null}
  onOpenChange={handleOpenChange}
  variant="verification"
>
  <Dialog.Title class="verification-title">{$i18n.t('settings.verification')}</Dialog.Title>
  {#if core.verification}
    {#if core.verification.state.phase === 'requested'}
      {#if core.verification.state.initiated_by_us}
        <p>{$i18n.t('settings.acceptOtherDevice')}</p>
        <p class="verification-wait">{$i18n.t('settings.waiting')}</p>
      {:else}
        <p>{$i18n.t('settings.verificationRequested')}</p>
        <Button variant="primary" class="verification-action" onclick={accept}
          >{$i18n.t('settings.acceptVerification')}</Button
        >
      {/if}
    {:else if core.verification.state.phase === 'waiting'}
      <p>{$i18n.t('settings.startingEmojiComparison')}</p>
      <p class="verification-wait">{$i18n.t('settings.waiting')}</p>
    {:else if core.verification.state.phase === 'compare'}
      <p>{$i18n.t('settings.compareEmoji')}</p>
      <div class="emoji" aria-label={$i18n.t('settings.verificationEmoji')}>
        {#each core.verification.state.emojis as emoji (emoji.symbol)}
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
      <p>{$i18n.t('settings.finishing')}</p>
      <p class="verification-wait">{$i18n.t('settings.waiting')}</p>
    {:else if core.verification.state.phase === 'done'}
      <p>{$i18n.t('settings.verificationComplete')}</p>
      <Button
        variant="primary"
        class="verification-action"
        onclick={() => (core.verification = null)}>{$i18n.t('settings.close')}</Button
      >
    {:else if core.verification.state.phase === 'cancelled'}
      <p>
        {$i18n.t('settings.verificationCancelled', { reason: core.verification.state.reason })}
      </p>
      <Button
        variant="primary"
        class="verification-action"
        onclick={() => (core.verification = null)}>{$i18n.t('settings.close')}</Button
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
    font-size: var(--font-size-large);
    font-weight: var(--font-weight-bold);
    margin: 0;
  }

  .emoji {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
    margin: 1rem 0;
  }

  .emoji-item {
    align-items: center;
    display: flex;
    flex: 1 1 4.5rem;
    flex-direction: column;
    gap: 0.25rem;
    text-align: center;
  }

  .emoji-item span {
    font-size: 2.25rem;
    line-height: 1;
  }

  .emoji-item small {
    color: var(--sable-surface-var-on-container);
  }

  .verification-actions {
    display: grid;
    gap: 0.5rem;
  }

  :global(.verification-action) {
    width: 100%;
  }

  :global(.verification-cancel) {
    margin-top: 0.5rem;
  }

  .verification-wait::before {
    background: currentcolor;
    border-radius: 50%;
    content: '';
    display: inline-block;
    height: 0.55rem;
    margin-right: 0.5rem;
    width: 0.55rem;
  }

  @media (prefers-reduced-motion: no-preference) {
    .verification-wait::before {
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
