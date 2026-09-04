<script lang="ts">
  import ClockIcon from 'phosphor-svelte/lib/ClockIcon';
  import PaperPlaneTiltIcon from 'phosphor-svelte/lib/PaperPlaneTiltIcon';
  import TrashIcon from 'phosphor-svelte/lib/TrashIcon';

  import type { ScheduledMessageView } from '#src/generated/ScheduledMessageView';
  import { useCoreClient } from '#lib/core/context.js';
  import { formatDate, formatTime } from '#lib/features/room/timeline-format.js';
  import { i18n } from '#lib/i18n.js';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';

  import { dequeue, queueFor } from './scheduled-queue.svelte.js';

  interface Props {
    roomId: string;
  }

  let { roomId }: Props = $props();

  const core = useCoreClient();
  let remote = $state.raw<ScheduledMessageView[]>([]);
  let expanded = $state(false);

  let local = $derived(queueFor(roomId));
  let total = $derived(remote.length + local.length);

  $effect(() => {
    const room = roomId;
    let alive = true;

    void core.commands
      .scheduledMessages(room)
      .then((messages) => {
        if (alive) remote = messages ?? [];
      })
      .catch((error: unknown) => {
        console.debug('[sable composer] scheduled messages unavailable', error);
      });

    return () => {
      alive = false;
    };
  });

  function when(ts: number | null): string {
    if (ts === null) return $i18n.t('composer.scheduledPending');
    return $i18n.t('composer.scheduledFor', {
      when: `${formatDate(ts)} ${formatTime(ts)}`,
    });
  }

  function cancelRemote(delayId: string): void {
    remote = remote.filter((message) => message.delay_id !== delayId);
    void core.commands.cancelScheduledMessage(delayId).catch((error: unknown) => {
      console.warn('[sable composer] cancelling a scheduled message failed', error);
    });
  }

  function sendRemote(delayId: string): void {
    remote = remote.filter((message) => message.delay_id !== delayId);
    void core.commands.sendScheduledMessage(delayId).catch((error: unknown) => {
      console.warn('[sable composer] sending a scheduled message failed', error);
    });
  }
</script>

{#if total > 0}
  <section class="scheduled" aria-label={$i18n.t('composer.scheduledCount', { count: total })}>
    <button
      type="button"
      class="summary"
      aria-expanded={expanded}
      onclick={() => {
        expanded = !expanded;
      }}
    >
      <ClockIcon size={16} aria-hidden="true" />
      {$i18n.t('composer.scheduledCount', { count: total })}
    </button>

    {#if expanded}
      <ul>
        {#each remote as message (message.delay_id)}
          <li>
            <span class="body">{message.body}</span>
            <span class="when">{when(message.delivery_ts)}</span>
            <IconButton
              variant="ghost"
              size="small"
              label={$i18n.t('composer.scheduledSendNow')}
              onclick={() => {
                sendRemote(message.delay_id);
              }}
            >
              <PaperPlaneTiltIcon />
            </IconButton>
            <IconButton
              variant="ghost"
              size="small"
              label={$i18n.t('composer.scheduledCancel')}
              onclick={() => {
                cancelRemote(message.delay_id);
              }}
            >
              <TrashIcon />
            </IconButton>
          </li>
        {/each}
        {#each local as message (message.id)}
          <li>
            <span class="body">{message.body}</span>
            <span class="when">{when(message.dueTs)}</span>
            <IconButton
              variant="ghost"
              size="small"
              label={$i18n.t('composer.scheduledCancel')}
              onclick={() => {
                dequeue(message.id);
              }}
            >
              <TrashIcon />
            </IconButton>
          </li>
        {/each}
      </ul>
    {/if}
  </section>
{/if}

<style>
  .scheduled {
    border-top: var(--border-width) solid var(--sable-surface-container-line);
    display: grid;
    gap: var(--space-100);
    padding: var(--space-200) var(--space-300) 0;
  }

  .summary {
    align-items: center;
    background: none;
    border: none;
    color: var(--sable-surface-var-on-container);
    cursor: pointer;
    display: flex;
    font: inherit;
    font-size: var(--font-size-small);
    gap: var(--space-100);
    justify-self: start;
    padding: 0;
  }

  .summary:hover {
    text-decoration: underline;
  }

  ul {
    display: grid;
    gap: var(--space-100);
    list-style: none;
    margin: 0;
    max-height: 9rem;
    overflow: auto;
    padding: 0;
  }

  li {
    align-items: center;
    display: flex;
    font-size: var(--font-size-small);
    gap: var(--space-200);
  }

  .body {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .when {
    color: var(--sable-surface-var-on-container);
    flex: none;
  }
</style>
