<script lang="ts">
  import { Dialog } from 'bits-ui';

  import { useCoreClient } from '$lib/core/context';
  import { verificationErrorMessage } from '$lib/core/verification-errors';
  import { i18n } from '$lib/i18n';
  import Alert from '$lib/ui/primitives/Alert.svelte';
  import Button from '$lib/ui/primitives/Button.svelte';
  import DialogFrame from '$lib/ui/primitives/DialogFrame.svelte';

  const core = useCoreClient();
  let error = $state<string | null>(null);

  // This app-level component keeps verification events flowing even when no
  // route-specific feature currently subscribes to the core transport.
  $effect(() => core.subscribeEvents(() => {}));

  async function accept(): Promise<void> {
    if (!core.verification || !core.session?.user_id) return;
    try {
      await core.acceptVerification(core.session.user_id, core.verification.flowId);
    } catch (cause) {
      error = verificationErrorMessage(cause);
    }
  }

  async function confirm(): Promise<void> {
    if (!core.verification || !core.session?.user_id) return;
    try {
      await core.confirmVerification(core.session.user_id, core.verification.flowId);
    } catch (cause) {
      error = verificationErrorMessage(cause);
    }
  }

  async function cancel(mismatch = false): Promise<void> {
    if (!core.verification || !core.session?.user_id) return;
    try {
      await core.cancelVerification(core.session.user_id, core.verification.flowId, mismatch);
    } catch (cause) {
      error = verificationErrorMessage(cause);
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
        <Dialog.Description class="verification-description">
          {$i18n.t('settings.acceptOtherDevice')}
        </Dialog.Description>
        <p class="verification-wait">{$i18n.t('settings.waiting')}</p>
      {:else}
        <Dialog.Description class="verification-description">
          {$i18n.t('settings.verificationRequested')}
        </Dialog.Description>
        <Button variant="primary" class="verification-action" onclick={accept}
          >{$i18n.t('settings.acceptVerification')}</Button
        >
      {/if}
    {:else if core.verification.state.phase === 'waiting'}
      <Dialog.Description class="verification-description">
        {$i18n.t('settings.startingEmojiComparison')}
      </Dialog.Description>
      <p class="verification-wait">{$i18n.t('settings.waiting')}</p>
    {:else if core.verification.state.phase === 'compare'}
      <Dialog.Description class="verification-description">
        {$i18n.t('settings.compareEmoji')}
      </Dialog.Description>
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
      <Dialog.Description class="verification-description">
        {$i18n.t('settings.finishing')}
      </Dialog.Description>
      <p class="verification-wait">{$i18n.t('settings.waiting')}</p>
    {:else if core.verification.state.phase === 'done'}
      <Dialog.Description class="verification-description">
        {$i18n.t('settings.verificationComplete')}
      </Dialog.Description>
      <Button
        variant="primary"
        class="verification-action"
        onclick={() => (core.verification = null)}>{$i18n.t('settings.close')}</Button
      >
    {:else if core.verification.state.phase === 'cancelled'}
      <Dialog.Description class="verification-description">
        {$i18n.t('settings.verificationCancelled', { reason: core.verification.state.reason })}
      </Dialog.Description>
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

  :global(.verification-description) {
    margin-bottom: var(--space-2);
  }

  .emoji {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    margin: var(--space-3) 0;
  }

  .emoji-item {
    align-items: center;
    display: flex;
    flex: 1 1 4.5rem;
    flex-direction: column;
    gap: calc(var(--space-1) / 2);
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
    gap: var(--space-1);
  }

  :global(.verification-action) {
    width: 100%;
  }

  :global(.verification-cancel) {
    margin-top: var(--space-1);
  }

  .verification-wait::before {
    background: currentcolor;
    border-radius: 50%;
    content: '';
    display: inline-block;
    height: 0.55rem;
    margin-right: var(--space-1);
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
