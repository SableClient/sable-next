<script lang="ts">
  import ClockIcon from 'phosphor-svelte/lib/ClockIcon';
  import PaperPlaneTiltIcon from 'phosphor-svelte/lib/PaperPlaneTiltIcon';
  import PencilSimpleIcon from 'phosphor-svelte/lib/PencilSimpleIcon';
  import TrashIcon from 'phosphor-svelte/lib/TrashIcon';

  import type { ScheduledMessageView } from '#src/generated/protocol';
  import { useCoreClient } from '#lib/core/context.js';
  import { formatDate, formatTime } from '#lib/features/room/timeline-format.js';
  import { i18n } from '#lib/i18n.js';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import { toasts } from '#lib/ui/toasts.svelte.js';

  import type { ScheduledTarget } from './composer-context';
  import { dequeue, enqueue, queueFor, type QueuedMessage } from './scheduled-queue.svelte.js';

  interface Props {
    roomId: string;
    revision?: number;
    editing?: string | null;
    onEdit?: (id: string, body: string, formatted: string | null, target: ScheduledTarget) => void;
  }

  let { roomId, revision = 0, editing = null, onEdit }: Props = $props();

  const core = useCoreClient();
  let fetched = $state.raw<ScheduledMessageView[]>([]);
  let pending = $state.raw<string[]>([]);
  let failure = $state<string | null>(null);
  let expanded = $state(false);

  let remote = $derived(
    fetched.filter((message) => message.delay_id !== editing && !pending.includes(message.delay_id))
  );
  let local = $derived(queueFor(roomId).filter((message) => message.id !== editing));
  let total = $derived(remote.length + local.length);

  $effect(() => {
    const room = roomId;
    void revision;
    let alive = true;

    void core.commands
      .scheduledMessages(room)
      .then((messages) => {
        if (alive) fetched = messages ?? [];
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

  function settle(delayId: string): void {
    pending = pending.filter((id) => id !== delayId);
  }

  function hold(delayId: string): void {
    failure = null;
    pending = [...pending, delayId];
  }

  async function cancelRemote(delayId: string): Promise<void> {
    try {
      await core.commands.cancelScheduledMessage(delayId);
      fetched = fetched.filter((message) => message.delay_id !== delayId);
    } catch (error) {
      console.warn('[sable composer] cancelling a scheduled message failed', error);
      failure = $i18n.t('composer.scheduledDeleteFailed');
    } finally {
      settle(delayId);
    }
  }

  function deleteRemote(delayId: string): void {
    hold(delayId);
    toasts.undoable($i18n.t('composer.scheduledDeleted'), {
      label: $i18n.t('composer.undo'),
      onUndo: () => {
        settle(delayId);
      },
      onClose: () => {
        void cancelRemote(delayId);
      },
    });
  }

  async function sendRemote(delayId: string): Promise<void> {
    hold(delayId);
    try {
      await core.commands.sendScheduledMessage(delayId);
      fetched = fetched.filter((message) => message.delay_id !== delayId);
    } catch (error) {
      console.warn('[sable composer] sending a scheduled message failed', error);
      failure = $i18n.t('composer.scheduledSendFailed');
    } finally {
      settle(delayId);
    }
  }

  function deleteLocal(message: QueuedMessage): void {
    failure = null;
    dequeue(message.id);
    toasts.undoable($i18n.t('composer.scheduledDeleted'), {
      label: $i18n.t('composer.undo'),
      onUndo: () => {
        enqueue(message);
      },
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

    {#if failure !== null}
      <Alert variant="critical" role="alert">{failure}</Alert>
    {/if}

    {#if expanded}
      <ul>
        {#each remote as message (message.delay_id)}
          <li>
            <span class="body">{message.body}</span>
            <span class="when">{when(message.delivery_ts)}</span>
            {#if onEdit}
              <IconButton
                variant="ghost"
                size="small"
                label={$i18n.t('composer.scheduledEdit')}
                onclick={() => {
                  onEdit(message.delay_id, message.body, message.formatted, {
                    source: 'server',
                    dueTs: message.delivery_ts,
                  });
                }}
              >
                <PencilSimpleIcon />
              </IconButton>
            {/if}
            <IconButton
              variant="ghost"
              size="small"
              label={$i18n.t('composer.scheduledSendNow')}
              onclick={() => {
                void sendRemote(message.delay_id);
              }}
            >
              <PaperPlaneTiltIcon />
            </IconButton>
            <IconButton
              variant="ghost"
              size="small"
              label={$i18n.t('composer.scheduledDelete')}
              onclick={() => {
                deleteRemote(message.delay_id);
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
            {#if onEdit}
              <IconButton
                variant="ghost"
                size="small"
                label={$i18n.t('composer.scheduledEdit')}
                onclick={() => {
                  onEdit(message.id, message.body, message.formatted, {
                    source: 'queue',
                    dueTs: message.dueTs,
                  });
                }}
              >
                <PencilSimpleIcon />
              </IconButton>
            {/if}
            <IconButton
              variant="ghost"
              size="small"
              label={$i18n.t('composer.scheduledDelete')}
              onclick={() => {
                deleteLocal(message);
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
    border-top: var(--border-width) solid var(--surface-container-line);
    display: grid;
    gap: var(--space-100);
    padding: var(--space-200) var(--space-300) 0;
  }

  .summary {
    align-items: center;
    background: none;
    border: none;
    color: var(--surface-var-on-container);
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
    color: var(--surface-var-on-container);
    flex: none;
  }
</style>
