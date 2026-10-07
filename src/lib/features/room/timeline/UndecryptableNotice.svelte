<script lang="ts">
  import type { UtdCauseView } from '#src/generated/protocol';

  import { resolve } from '$app/paths';

  import { i18n } from '#lib/i18n.js';
  import { useCoreClient } from '#lib/core/context.js';
  import { SETTINGS_DEVICES_SECTION } from '#lib/settings/registry.js';
  import { toasts } from '#lib/ui/toasts.svelte.js';

  import { utdCauseKey, utdIsRecoverable } from './utd-cause';
  import { utdGraceRemaining } from './utd-grace';

  interface Props {
    id: string;
    cause: UtdCauseView;
    roomId: string;
    sessionId: string | null;
    sender: string | null;
    threadRoot: string | null;
  }

  let { id, cause, roomId, sessionId, sender, threadRoot }: Props = $props();
  const core = useCoreClient();

  let waiting = $state(false);
  let retrying = $state(false);

  async function retry(): Promise<void> {
    if (!sessionId || !sender || !roomId || retrying) return;
    retrying = true;
    try {
      await core.commands.retryDecryption(roomId, sessionId, sender, threadRoot);
    } catch (error) {
      console.warn('[sable timeline] could not retry decryption', error);
      toasts.error($i18n.t('errors.actionFailed'));
    } finally {
      retrying = false;
    }
  }

  $effect(() => {
    const remaining = utdGraceRemaining(id);
    if (remaining === 0) {
      waiting = false;
      return;
    }
    waiting = true;
    const timer = setTimeout(() => {
      waiting = false;
    }, remaining);
    return () => {
      clearTimeout(timer);
    };
  });
</script>

<p class="undecryptable" class:waiting>
  {#if waiting}
    {$i18n.t('timeline.utdWaiting')}
  {:else}
    {$i18n.t(utdCauseKey(cause))}
    {#if sessionId && sender && roomId}
      <button type="button" disabled={retrying} onclick={() => void retry()}>
        {$i18n.t('timeline.retryDecryption')}
      </button>
    {/if}
    {#if utdIsRecoverable(cause)}
      <a
        href={resolve('/(app)/settings/[section]', { section: SETTINGS_DEVICES_SECTION })}
        draggable="false"
        data-settings-link={SETTINGS_DEVICES_SECTION}
      >
        {$i18n.t('common.setUpRecovery')}
      </a>
    {/if}
  {/if}
</p>

<style>
  .undecryptable {
    background: var(--surface-var-container);
    border: var(--border-width) dashed var(--surface-var-container-line);
    border-radius: var(--radius);
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    margin: 0;
    margin-inline-start: calc(var(--avatar-size-small) + var(--space-250));
    max-width: 32rem;
    padding: var(--space-150) var(--space-200);
    width: fit-content;
  }

  .waiting {
    opacity: 0.7;
  }
</style>
