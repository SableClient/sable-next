<script lang="ts">
  import { useCoreClient } from '$lib/core/context';

  const core = useCoreClient();

  const notice = $derived.by(() => {
    if (core.crashed !== null) {
      return { kind: 'crash' as const, text: 'Sable hit an internal error and stopped syncing.' };
    }
    if (core.unresponsive) {
      return { kind: 'warn' as const, text: 'Sable is not responding.' };
    }
    if (core.sync?.state === 'error') {
      return { kind: 'warn' as const, text: `Sync failed: ${core.sync.message}` };
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
      <button type="button" onclick={reload}>Reload</button>
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

  button {
    background: var(--sable-crit-main);
    border: 0;
    border-radius: var(--radius-pill);
    color: var(--sable-crit-on-main);
    cursor: pointer;
    padding: var(--space-1) var(--space-2);
  }

  button:hover {
    background: var(--sable-crit-main-hover);
  }

  button:active {
    background: var(--sable-crit-main-active);
  }
</style>
