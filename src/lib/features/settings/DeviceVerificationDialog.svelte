<script lang="ts">
  import { Dialog } from 'bits-ui';

  import { CoreError } from '@/transport';
  import { useCoreClient } from '$lib/core/context';
  import { i18n, t } from '$lib/i18n';
  import Button from '$lib/ui/primitives/Button.svelte';

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

<Dialog.Root open={core.verification !== null} onOpenChange={handleOpenChange}>
  <Dialog.Portal>
    <Dialog.Overlay class="verification-backdrop" />
    <Dialog.Content class="verification-dialog">
      <Dialog.Title class="verification-title">{$i18n.t('settings.verification')}</Dialog.Title>
      {#if core.verification}
        {#if core.verification.state.phase === 'requested'}
          {#if core.verification.state.initiated_by_us}
            <p>{$i18n.t('settings.acceptOtherDevice')}</p>
            <p class="verification-wait">{$i18n.t('settings.waiting')}</p>
          {:else}
            <p>{$i18n.t('settings.verificationRequested')}</p>
            <Button class="verification-primary" onclick={accept}
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
            <Button class="verification-primary" onclick={confirm}
              >{$i18n.t('settings.theyMatch')}</Button
            >
            <button
              type="button"
              class="verification-secondary danger-button"
              onclick={() => void cancel(true)}>{$i18n.t('settings.theyDoNotMatch')}</button
            >
          </div>
        {:else if core.verification.state.phase === 'confirmed'}
          <p>{$i18n.t('settings.finishing')}</p>
          <p class="verification-wait">{$i18n.t('settings.waiting')}</p>
        {:else if core.verification.state.phase === 'done'}
          <p>{$i18n.t('settings.verificationComplete')}</p>
          <Button class="verification-primary" onclick={() => (core.verification = null)}
            >{$i18n.t('settings.close')}</Button
          >
        {:else if core.verification.state.phase === 'cancelled'}
          <p>
            {$i18n.t('settings.verificationCancelled', { reason: core.verification.state.reason })}
          </p>
          <Button class="verification-primary" onclick={() => (core.verification = null)}
            >{$i18n.t('settings.close')}</Button
          >
        {/if}
        {#if error}<p class="error" role="alert">{error}</p>{/if}
        {#if core.verification.state.phase !== 'done' && core.verification.state.phase !== 'cancelled'}
          <button
            type="button"
            class="verification-secondary text-button"
            onclick={() => void cancel()}>{$i18n.t('settings.cancelVerification')}</button
          >
        {/if}
      {/if}
    </Dialog.Content>
  </Dialog.Portal>
</Dialog.Root>

<style>
  :global(.verification-backdrop) {
    background: var(--sable-overlay);
    inset: 0;
    position: fixed;
    z-index: 40;
  }

  :global(.verification-dialog) {
    background: var(--sable-primary-container);
    border: 1px solid var(--sable-primary-container-line);
    border-radius: var(--radius) var(--radius) 0 0;
    bottom: 0;
    box-shadow: 0 1.5rem 3rem var(--sable-shadow);
    box-sizing: border-box;
    max-height: calc(100dvh - 1.5rem);
    overflow: auto;
    padding: 1.25rem;
    position: fixed;
    width: 100%;
    z-index: 41;
  }

  :global(.verification-title) {
    font-size: var(--font-size-large);
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

  :global(.verification-primary),
  .verification-secondary {
    width: 100%;
  }

  .text-button,
  .danger-button {
    background: none;
    border: 0;
    cursor: pointer;
    font: inherit;
    padding: 0.75rem;
  }

  .text-button {
    color: var(--sable-primary-main);
    margin-top: 0.5rem;
  }

  .danger-button {
    color: var(--sable-crit-main);
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

  .error {
    background: var(--sable-crit-container);
    border-radius: var(--radius);
    color: var(--sable-crit-on-container);
    padding: 0.75rem;
  }

  @keyframes pulse {
    50% {
      opacity: 0.3;
    }
  }

  @media (width >= 42rem) {
    :global(.verification-dialog) {
      border-radius: var(--radius);
      bottom: auto;
      left: 50%;
      max-width: 34rem;
      padding: 1.5rem;
      top: 50%;
      transform: translate(-50%, -50%);
    }

    .verification-actions {
      display: flex;
    }

    :global(.verification-primary),
    .verification-secondary {
      width: auto;
    }
  }
</style>
