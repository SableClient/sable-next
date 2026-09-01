<script lang="ts">
  import type { UtdCauseView } from '#src/generated/UtdCauseView';

  import { resolve } from '$app/paths';

  import { i18n } from '#lib/i18n.js';
  import { SETTINGS_DEVICES_SECTION } from '#lib/settings/registry.js';

  import { utdCauseKey, utdIsRecoverable } from './utd-cause';
  import { utdGraceRemaining } from './utd-grace';

  interface Props {
    id: string;
    cause: UtdCauseView;
  }

  let { id, cause }: Props = $props();

  let waiting = $state(false);

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
    {#if utdIsRecoverable(cause)}
      <a
        href={resolve('/(app)/settings/[section]', { section: SETTINGS_DEVICES_SECTION })}
        data-settings-link={SETTINGS_DEVICES_SECTION}
      >
        {$i18n.t('timeline.utdRecoverAction')}
      </a>
    {/if}
  {/if}
</p>

<style>
  .undecryptable {
    background: var(--sable-surface-var-container);
    border: var(--border-width) dashed var(--sable-surface-var-container-line);
    border-radius: var(--radius);
    color: var(--sable-surface-var-on-container);
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
