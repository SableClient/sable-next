<script lang="ts">
  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import Button from './primitives/Button.svelte';

  const core = useCoreClient();

  let offlineSettled = $state(false);

  $effect(() => {
    if (core.sync?.state !== 'offline') {
      offlineSettled = false;
      return;
    }
    const timer = setTimeout(() => (offlineSettled = true), 3000);
    return () => clearTimeout(timer);
  });

  const notice = $derived.by(() => {
    if (core.crashed !== null) {
      return { kind: 'crash' as const, text: i18n.t('errors.coreCrashed') };
    }
    if (core.superseded) {
      return { kind: 'crash' as const, text: i18n.t('errors.coreSuperseded') };
    }
    if (core.storageInterrupted) {
      return { kind: 'crash' as const, text: i18n.t('errors.storageInterrupted') };
    }
    if (core.unresponsive) {
      return { kind: 'warn' as const, text: i18n.t('errors.coreUnresponsive') };
    }
    if (core.localNetworkBlocked !== null) {
      return {
        kind: 'warn' as const,
        text: i18n.t('errors.localNetworkBlocked', { host: core.localNetworkBlocked }),
      };
    }
    if (core.sync?.state === 'error') {
      return {
        kind: 'warn' as const,
        text: i18n.t('errors.syncFailed', { message: core.sync.message }),
      };
    }
    if (offlineSettled && core.localNetworkOffer !== null) {
      return {
        kind: 'offer' as const,
        text: i18n.t('errors.localNetworkOffer', { host: core.localNetworkOffer }),
      };
    }
    if (offlineSettled) {
      return { kind: 'retry' as const, text: i18n.t('errors.offline') };
    }
    return null;
  });

  function reload(): void {
    location.reload();
  }
</script>

<svelte:document
  onvisibilitychange={() => {
    if (document.visibilityState === 'visible' && core.storageInterrupted) reload();
  }}
/>

{#if notice}
  <div class={['banner', { crash: notice.kind === 'crash' }]} role="alert">
    <p class="message">{notice.text}</p>
    {#if notice.kind === 'crash'}
      <Button class="reload-button" size="small" variant="danger" onclick={reload}
        >{i18n.t('common.reload')}</Button
      >
    {:else if notice.kind === 'offer'}
      <Button size="small" variant="ghost" onclick={() => core.declineLocalNetwork()}
        >{i18n.t('errors.localNetworkDecline')}</Button
      >
      <Button size="small" onclick={() => void core.allowLocalNetwork()}
        >{i18n.t('errors.localNetworkAllow')}</Button
      >
    {:else if notice.kind === 'retry'}
      <Button size="small" variant="ghost" onclick={() => void core.retrySync()}
        >{i18n.t('common.retry')}</Button
      >
    {/if}
  </div>
{/if}

<style>
  .banner {
    align-items: center;
    background: var(--warn-container);
    border-block-start: var(--border-width) solid var(--warn-container-line);
    color: var(--warn-on-container);
    display: flex;
    gap: var(--space-300);
    inset-block-start: 0;
    inset-inline: 0;
    justify-content: center;
    padding: var(--space-300) var(--space-400);
    z-index: var(--layer-notify);
  }

  .crash {
    background: var(--crit-container);
    border-block-end-color: var(--crit-container-line);
    color: var(--crit-on-container);
  }

  .message {
    margin: 0;
    user-select: text;
  }

  :global(.reload-button) {
    background-color: var(--crit-container-active);
    flex: none;
  }
</style>
