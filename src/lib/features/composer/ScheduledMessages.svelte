<script lang="ts">
  import CaretDownIcon from 'phosphor-svelte/lib/CaretDownIcon';
  import CaretUpIcon from 'phosphor-svelte/lib/CaretUpIcon';
  import ClockIcon from 'phosphor-svelte/lib/ClockIcon';
  import DotsThreeVerticalIcon from 'phosphor-svelte/lib/DotsThreeVerticalIcon';
  import IconContext from 'phosphor-svelte/lib/IconContext';
  import PaperPlaneTiltIcon from 'phosphor-svelte/lib/PaperPlaneTiltIcon';
  import PencilSimpleIcon from 'phosphor-svelte/lib/PencilSimpleIcon';
  import TrashIcon from 'phosphor-svelte/lib/TrashIcon';

  import type { ScheduledMessageView } from '#src/generated/protocol';
  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import ActionMenu from '#lib/ui/primitives/ActionMenu.svelte';
  import ActionMenuItem from '#lib/ui/primitives/ActionMenuItem.svelte';
  import Alert from '#lib/ui/primitives/Alert.svelte';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import { toasts } from '#lib/ui/toasts.svelte.js';

  import type { ScheduledTarget } from './composer-context';
  import { scheduledTimeLabel } from './schedule-time.js';
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

  const PREVIEW_LABEL_LENGTH = 40;

  function when(ts: number | null): string {
    if (ts === null) return $i18n.t('composer.scheduledPending');
    return $i18n.t('composer.scheduledFor', { when: scheduledTimeLabel(ts, Date.now()) });
  }

  function actionsLabel(body: string): string {
    const preview =
      body.length > PREVIEW_LABEL_LENGTH ? `${body.slice(0, PREVIEW_LABEL_LENGTH)}…` : body;
    return $i18n.t('composer.scheduledActions', { preview });
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

  async function sendLocal(message: QueuedMessage): Promise<void> {
    failure = null;
    dequeue(message.id);
    try {
      await core.commands.sendMessage(message.roomId, message.body, {
        formatted: message.formatted,
      });
    } catch (error) {
      console.warn('[sable composer] sending a queued message failed', error);
      enqueue(message);
      failure = $i18n.t('composer.scheduledSendFailed');
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

{#snippet row(
  body: string,
  sends: string,
  onEditMessage: (() => void) | null,
  onSendNow: () => void,
  onDelete: () => void
)}
  <li>
    <div class="text">
      <span class="preview">{body}</span>
      <span class="when">{sends}</span>
    </div>
    <ActionMenu label={actionsLabel(body)}>
      {#snippet trigger({ props })}
        <IconButton {...props} variant="ghost" size="small" label={actionsLabel(body)}>
          <DotsThreeVerticalIcon />
        </IconButton>
      {/snippet}
      <IconContext values={{ 'aria-hidden': 'true' }}>
        {#if onEditMessage}
          <ActionMenuItem onSelect={onEditMessage}>
            <PencilSimpleIcon />
            {$i18n.t('composer.scheduledEdit')}
          </ActionMenuItem>
        {/if}
        <ActionMenuItem onSelect={onSendNow}>
          <PaperPlaneTiltIcon />
          {$i18n.t('composer.scheduledSendNow')}
        </ActionMenuItem>
        <ActionMenuItem destructive onSelect={onDelete}>
          <TrashIcon />
          {$i18n.t('composer.scheduledDelete')}
        </ActionMenuItem>
      </IconContext>
    </ActionMenu>
  </li>
{/snippet}

{#if total > 0}
  <section class="scheduled" aria-label={$i18n.t('composer.scheduledCount', { count: total })}>
    <button
      type="button"
      class="pill"
      aria-expanded={expanded}
      onclick={() => {
        expanded = !expanded;
      }}
    >
      <ClockIcon aria-hidden="true" />
      {$i18n.t('composer.scheduledPill', { count: total })}
      {#if expanded}
        <CaretUpIcon aria-hidden="true" />
      {:else}
        <CaretDownIcon aria-hidden="true" />
      {/if}
    </button>

    {#if failure !== null}
      <Alert variant="critical" role="alert">{failure}</Alert>
    {/if}

    {#if expanded}
      <ul>
        {#each remote as message (message.delay_id)}
          {@render row(
            message.body,
            when(message.delivery_ts),
            onEdit
              ? () => {
                  onEdit(message.delay_id, message.body, message.formatted, {
                    source: 'server',
                    dueTs: message.delivery_ts,
                  });
                }
              : null,
            () => void sendRemote(message.delay_id),
            () => {
              deleteRemote(message.delay_id);
            }
          )}
        {/each}
        {#each local as message (message.id)}
          {@render row(
            message.body,
            when(message.dueTs),
            onEdit
              ? () => {
                  onEdit(message.id, message.body, message.formatted, {
                    source: 'queue',
                    dueTs: message.dueTs,
                  });
                }
              : null,
            () => void sendLocal(message),
            () => {
              deleteLocal(message);
            }
          )}
        {/each}
      </ul>
    {/if}
  </section>
{/if}

<style>
  .scheduled {
    display: grid;
    gap: var(--space-150);
    margin-inline: var(--space-150);
    padding-block: var(--space-150);
  }

  .pill {
    align-items: center;
    background: var(--surface-var-container);
    border: var(--border-width) solid var(--surface-var-container-line);
    border-radius: var(--radius-pill);
    color: var(--surface-var-on-container);
    cursor: pointer;
    display: inline-flex;
    font: inherit;
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-medium);
    gap: var(--space-100);
    justify-self: start;
    padding: var(--space-050) var(--space-200);
  }

  .pill:hover {
    background: var(--surface-var-container-hover);
  }

  ul {
    display: grid;
    gap: var(--space-100);
    grid-template-columns: minmax(0, 1fr);
    list-style: none;
    margin: 0;
    max-height: 12rem;
    overflow: hidden auto;
    padding: 0;
  }

  li {
    align-items: center;
    display: flex;
    font-size: var(--font-size-small);
    gap: var(--space-200);
    min-width: 0;
  }

  .text {
    display: grid;
    flex: 1;
    gap: var(--space-050);
    min-width: 0;
  }

  .preview {
    -webkit-box-orient: vertical;
    color: var(--surface-on-container);
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    line-height: var(--line-height-small);
    overflow: hidden;
    overflow-wrap: anywhere;
  }

  .when {
    color: var(--surface-var-on-container);
  }
</style>
