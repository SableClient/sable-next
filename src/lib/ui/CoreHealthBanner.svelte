<script lang="ts">
  import { useCoreClient } from '$lib/core/context';
  import { i18n } from '$lib/i18n';
  import Button from './primitives/Button.svelte';

  const core = useCoreClient();

  const notice = $derived.by(() => {
    if (core.crashed !== null) {
      return { kind: 'crash' as const, text: $i18n.t('errors.coreCrashed') };
    }
    if (core.unresponsive) {
      return { kind: 'warn' as const, text: $i18n.t('errors.coreUnresponsive') };
    }
    if (core.sync?.state === 'error') {
      return {
        kind: 'warn' as const,
        text: $i18n.t('errors.syncFailed', { message: core.sync.message }),
      };
    }
    return null;
  });

  function reload(): void {
    location.reload();
  }
</script>

{#if notice}
  <div class="banner" class:crash={notice.kind === 'crash'} role="alert">
    <p class="message">{notice.text}</p>
    {#if notice.kind === 'crash'}
      <Button size="small" variant="danger" onclick={reload}>{$i18n.t('errors.reload')}</Button>
    {/if}
  </div>
{/if}

<style>
  .banner {
    align-items: center;
    background: var(--sable-warn-container);
    border-block-end: 1px solid var(--sable-warn-container-line);
    color: var(--sable-warn-on-container);
    display: flex;
    gap: var(--space-2);
    inset-block-start: 0;
    inset-inline: 0;
    justify-content: center;
    padding: var(--space-2) var(--space-3);
    position: fixed;
    z-index: 100;
  }

  .crash {
    background: var(--sable-crit-container);
    border-block-end-color: var(--sable-crit-container-line);
    color: var(--sable-crit-on-container);
  }

  .message {
    margin: 0;
  }

  :global(.sable-button) {
    flex: none;
  }
</style>
