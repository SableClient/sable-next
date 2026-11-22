<script lang="ts">
  import { onDestroy, tick } from 'svelte';
  import BookmarkSimpleIcon from 'phosphor-svelte/lib/BookmarkSimpleIcon';
  import ChecksIcon from 'phosphor-svelte/lib/ChecksIcon';
  import CopyIcon from 'phosphor-svelte/lib/CopyIcon';
  import DotsThreeIcon from 'phosphor-svelte/lib/DotsThreeIcon';
  import FlagIcon from 'phosphor-svelte/lib/FlagIcon';
  import IconContext from 'phosphor-svelte/lib/IconContext';
  import ShareFatIcon from 'phosphor-svelte/lib/ShareFatIcon';
  import TrashIcon from 'phosphor-svelte/lib/TrashIcon';
  import UserSwitchIcon from 'phosphor-svelte/lib/UserSwitchIcon';
  import XIcon from 'phosphor-svelte/lib/XIcon';

  import type {
    MemberView,
    PerMessageProfileView,
    PersonaView,
    TimelineItemView,
  } from '#src/generated/protocol';
  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import { usePersonaStore } from '#lib/personas/personas.svelte.js';
  import { copyText } from '#lib/platform/clipboard.js';
  import { useBookmarks } from '#lib/rooms/bookmarks.svelte.js';
  import { useRoomList } from '#lib/rooms/room-list.svelte.js';
  import { preferences } from '#lib/settings/preferences.svelte.js';
  import ActionMenu from '#lib/ui/primitives/ActionMenu.svelte';
  import ActionMenuItem from '#lib/ui/primitives/ActionMenuItem.svelte';
  import ActionMenuSeparator from '#lib/ui/primitives/ActionMenuSeparator.svelte';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import Spinner from '#lib/ui/primitives/Spinner.svelte';
  import Tooltip from '#lib/ui/primitives/Tooltip.svelte';
  import { rovingFocus } from '#lib/ui/roving-focus.js';
  import { toasts } from '#lib/ui/toasts.svelte.js';

  import DeleteMessageDialog from './DeleteMessageDialog.svelte';
  import MessageForwardDialog from './MessageForwardDialog.svelte';
  import MessageReportDialog from './MessageReportDialog.svelte';
  import MessageReproxyDialog from './MessageReproxyDialog.svelte';
  import {
    batchCapabilities,
    formatCopiedMessages,
    forwardToRooms,
    messageCopyText,
    reproxyEvent,
    runBatch,
    type BatchOutcome,
    type BatchProgress,
    type MessageSelection,
  } from './message-selection.svelte.js';

  interface Props {
    selection: MessageSelection;
    events: { get(eventId: string): TimelineItemView | null };
    roomId?: string;
    threadRootId?: string | null;
    members?: readonly MemberView[];
    selectableCount: number;
    canEdit: boolean;
    canDelete: boolean;
    canRedactOwn: boolean;
    canRedactOthers: boolean;
    onExit?: () => void;
  }

  let {
    selection,
    events,
    roomId = '',
    threadRootId = null,
    members = [],
    selectableCount,
    canEdit,
    canDelete,
    canRedactOwn,
    canRedactOthers,
    onExit,
  }: Props = $props();

  const core = useCoreClient();
  const bookmarks = useBookmarks();
  const personaStore = usePersonaStore();
  const roomList = useRoomList();

  let deleteOpen = $state(false);
  let forwardOpen = $state(false);
  let reportOpen = $state(false);
  let reproxyOpen = $state(false);

  let barElement = $state<HTMLDivElement>();
  let busy = $state(false);
  let progress = $state<BatchProgress | null>(null);
  let activeRun: AbortController | null = null;
  let disposed = false;

  onDestroy(() => {
    disposed = true;
    activeRun?.abort();
  });

  let selectedItems = $derived(selection.selected(events));
  let caps = $derived(
    batchCapabilities(selectedItems, {
      roomId,
      canEdit,
      canDelete,
      canRedactOwn,
      canRedactOthers,
      bookmarks,
    })
  );
  let canSelectAll = $derived(selection.count < selectableCount);
  let hasMore = $derived(canSelectAll || caps.reproxyable.length > 0 || caps.reportable.length > 0);
  let reproxyCurrent = $derived.by((): PerMessageProfileView | null | 'mixed' => {
    const items = caps.reproxyable;
    if (items.length === 0) return null;
    const first = items[0].per_message_profile;
    const firstId = first?.id ?? null;
    for (let index = 1; index < items.length; index += 1) {
      if ((items[index].per_message_profile?.id ?? null) !== firstId) return 'mixed';
    }
    return first;
  });

  let copyLabel = $derived(i18n.t('timeline.batchCopy', { count: caps.copyable.length }));
  let forwardLabel = $derived(i18n.t('timeline.batchForward', { count: caps.forwardable.length }));
  let bookmarkLabel = $derived(
    i18n.t(caps.allBookmarked ? 'timeline.batchUnbookmark' : 'timeline.batchBookmark', {
      count: caps.bookmarkable.length,
    })
  );
  let deleteLabel = $derived(i18n.t('timeline.batchDelete', { count: caps.deletable.length }));
  let reproxyLabel = $derived(i18n.t('timeline.batchReproxy', { count: caps.reproxyable.length }));
  let reportLabel = $derived(i18n.t('timeline.batchReport', { count: caps.reportable.length }));

  export function cancelOrClear(): void {
    if (busy) {
      activeRun?.abort();
      return;
    }
    selection.clear();
    onExit?.();
  }

  function selectAllLoaded(): void {
    selection.selectAll();
    void tick().then(() => {
      if (
        !hasMore &&
        barElement &&
        (document.activeElement === null ||
          document.activeElement === document.body ||
          !document.activeElement.isConnected)
      ) {
        barElement
          .querySelector<HTMLElement>(
            '.selection-actions button:not(:disabled), .selection-start button'
          )
          ?.focus();
      }
    });
  }

  async function runActionBatch(
    items: readonly TimelineItemView[],
    run: (item: TimelineItemView) => Promise<void>,
    succeededMessage: (count: number) => string,
    after?: (outcome: BatchOutcome<TimelineItemView>) => Promise<void> | void
  ): Promise<void> {
    const controller = new AbortController();
    activeRun = controller;
    busy = true;
    progress = { completed: 0, total: items.length };
    let outcome: BatchOutcome<TimelineItemView>;
    try {
      outcome = await runBatch(items, run, {
        signal: controller.signal,
        onProgress: (next) => {
          if (!disposed) progress = next;
        },
      });
    } finally {
      if (activeRun === controller) activeRun = null;
      if (!disposed) {
        busy = false;
        progress = null;
      }
    }
    if (disposed) return;
    await after?.(outcome);
    if (disposed) return;

    const total = outcome.succeeded.length + outcome.failed.length + outcome.remaining.length;
    if (outcome.failed.length === 0 && !outcome.cancelled) {
      selection.clear();
      onExit?.();
      toasts.info(succeededMessage(outcome.succeeded.length));
      return;
    }

    const keepIds = [
      ...outcome.failed.map((entry) => entry.item.event_id),
      ...outcome.remaining.map((item) => item.event_id),
    ].filter((id): id is string => id !== null);
    if (keepIds.length === 0) {
      selection.clear();
      onExit?.();
    } else {
      selection.keepOnly(keepIds);
    }

    if (outcome.cancelled && outcome.failed.length === 0) {
      toasts.info(i18n.t('timeline.batchStopped', { completed: outcome.succeeded.length, total }));
    } else if (outcome.succeeded.length > 0) {
      toasts.error(
        i18n.t('timeline.batchPartialFailure', {
          succeeded: outcome.succeeded.length,
          total,
          count: outcome.failed.length,
        })
      );
    } else {
      toasts.error(i18n.t('timeline.batchAllFailed', { count: outcome.failed.length }));
    }
  }

  async function copySelected(): Promise<void> {
    if (busy || caps.copyable.length === 0) return;
    const text = formatCopiedMessages(caps.copyable, members);
    if (!text) return;
    try {
      await copyText(text);
      const count = caps.copyable.length;
      selection.clear();
      onExit?.();
      toasts.info(i18n.t('timeline.batchCopied', { count }));
    } catch (error: unknown) {
      console.debug('[sable timeline] copy messages failed', error);
      toasts.error(i18n.t('errors.actionFailed'));
    }
  }

  async function runDeleteBatch(reason: string | null): Promise<void> {
    if (busy || !roomId || caps.deletable.length === 0) return;
    await runActionBatch(
      caps.deletable,
      async (item) => {
        if (!item.event_id) return;
        await core.rpc.messages.redact({
          room_id: roomId,
          event_id: item.event_id,
          reason,
          thread_root: threadRootId,
        });
      },
      (count) => i18n.t('timeline.batchDeleted', { count })
    );
  }

  async function runForwardBatch(toRoomIds: string[], includeMetadata: boolean): Promise<void> {
    if (busy || !roomId || toRoomIds.length === 0 || caps.forwardable.length === 0) return;
    await runActionBatch(
      caps.forwardable,
      async (item) => {
        if (!item.event_id) return;
        await forwardToRooms(core.rpc, personaStore, roomList, {
          roomId,
          eventId: item.event_id,
          toRoomIds,
          includeMetadata,
        });
      },
      (count) => i18n.t('timeline.batchForwarded', { count })
    );
  }

  async function runBookmarkBatch(): Promise<void> {
    if (busy || !roomId || caps.bookmarkable.length === 0) return;
    const target = !caps.allBookmarked;
    const items = caps.bookmarkable.filter(
      (item) => bookmarks.has(roomId, item.event_id) !== target
    );
    if (items.length === 0) {
      selection.clear();
      onExit?.();
      return;
    }
    await runActionBatch(
      items,
      async (item) => {
        if (item.event_id) await bookmarks.set(roomId, item.event_id, target, { refresh: false });
      },
      (count) =>
        i18n.t(target ? 'timeline.batchBookmarked' : 'timeline.batchUnbookmarked', { count }),
      async (outcome) => {
        if (target && outcome.succeeded.length > 0) await bookmarks.refresh();
      }
    );
  }

  async function runReproxyBatch(persona: PersonaView | null): Promise<void> {
    if (busy || !roomId || caps.reproxyable.length === 0) return;
    const snapshot = $state.snapshot(persona);
    await runActionBatch(
      caps.reproxyable,
      (item) =>
        reproxyEvent(core.rpc, {
          roomId,
          item,
          persona: snapshot,
          personaFallback: preferences.personaFallback,
        }),
      (count) => i18n.t('timeline.batchReproxied', { count })
    );
  }

  async function runReportBatch(reason: string | null): Promise<void> {
    if (busy || !roomId || caps.reportable.length === 0) return;
    await runActionBatch(
      caps.reportable,
      async (item) => {
        if (!item.event_id) return;
        await core.rpc.messages.report({ room_id: roomId, event_id: item.event_id, reason });
      },
      (count) => i18n.t('timeline.batchReported', { count })
    );
  }
</script>

<div
  bind:this={barElement}
  class="selection-bar"
  role="region"
  aria-label={i18n.t('timeline.selectionBar')}
>
  <div class="selection-start">
    <Tooltip label={i18n.t(busy ? 'timeline.selectionCancel' : 'timeline.selectionClear')}>
      {#snippet trigger({ props })}
        <IconButton
          {...props}
          type="button"
          variant="ghost"
          size="medium"
          label={i18n.t(busy ? 'timeline.selectionCancel' : 'timeline.selectionClear')}
          onclick={cancelOrClear}
        >
          <XIcon />
        </IconButton>
      {/snippet}
    </Tooltip>
    <span class="selection-count">
      {#if busy && progress}
        <Spinner small />
        <span
          >{i18n.t('timeline.batchProgress', {
            completed: progress.completed,
            total: progress.total,
          })}</span
        >
      {:else}
        {i18n.t('timeline.selectedCount', { count: selection.count })}
      {/if}
    </span>
  </div>

  <div
    class="selection-actions"
    role="toolbar"
    aria-label={i18n.t('timeline.selectionActions')}
    {@attach rovingFocus()}
  >
    {#if caps.copyable.length > 0}
      <Tooltip label={copyLabel} disabled={busy}>
        {#snippet trigger({ props })}
          <IconButton
            {...props}
            type="button"
            variant="ghost"
            size="medium"
            disabled={busy}
            label={copyLabel}
            onclick={() => void copySelected()}
          >
            <CopyIcon />
          </IconButton>
        {/snippet}
      </Tooltip>
    {/if}

    {#if caps.forwardable.length > 0}
      <Tooltip label={forwardLabel} disabled={busy}>
        {#snippet trigger({ props })}
          <IconButton
            {...props}
            type="button"
            variant="ghost"
            size="medium"
            disabled={busy}
            label={forwardLabel}
            onclick={() => {
              forwardOpen = true;
            }}
          >
            <ShareFatIcon class="mirror-rtl" />
          </IconButton>
        {/snippet}
      </Tooltip>
    {/if}

    {#if caps.bookmarkable.length > 0}
      <Tooltip label={bookmarkLabel} disabled={busy}>
        {#snippet trigger({ props })}
          <IconButton
            {...props}
            type="button"
            variant="ghost"
            size="medium"
            disabled={busy}
            label={bookmarkLabel}
            onclick={() => void runBookmarkBatch()}
          >
            <BookmarkSimpleIcon weight={caps.allBookmarked ? 'fill' : 'regular'} />
          </IconButton>
        {/snippet}
      </Tooltip>
    {/if}

    {#if caps.deletable.length > 0}
      <Tooltip label={deleteLabel} disabled={busy}>
        {#snippet trigger({ props })}
          <IconButton
            {...props}
            type="button"
            class="selection-danger"
            variant="ghost"
            size="medium"
            disabled={busy}
            label={deleteLabel}
            onclick={() => {
              deleteOpen = true;
            }}
          >
            <TrashIcon />
          </IconButton>
        {/snippet}
      </Tooltip>
    {/if}

    {#if hasMore}
      <ActionMenu label={i18n.t('timeline.moreActions')} align="end">
        {#snippet trigger({ props })}
          <IconButton
            {...props}
            type="button"
            class="selection-open"
            variant="ghost"
            size="medium"
            disabled={busy}
            label={i18n.t('timeline.moreActions')}
          >
            <DotsThreeIcon />
          </IconButton>
        {/snippet}
        <IconContext values={{ 'aria-hidden': 'true' }}>
          {#if canSelectAll}
            <ActionMenuItem
              class="menu-item-trailing-icon"
              onSelect={() => {
                selectAllLoaded();
              }}
            >
              <ChecksIcon />
              <span>{i18n.t('timeline.selectAllLoaded')}</span>
            </ActionMenuItem>
          {/if}
          {#if caps.reproxyable.length > 0}
            {#if canSelectAll}<ActionMenuSeparator />{/if}
            <ActionMenuItem
              class="menu-item-trailing-icon"
              onSelect={() => {
                void personaStore.load();
                reproxyOpen = true;
              }}
            >
              <UserSwitchIcon />
              <span>{reproxyLabel}</span>
            </ActionMenuItem>
          {/if}
          {#if caps.reportable.length > 0}
            {#if canSelectAll || caps.reproxyable.length > 0}<ActionMenuSeparator />{/if}
            <ActionMenuItem
              class="menu-item-trailing-icon"
              onSelect={() => {
                reportOpen = true;
              }}
            >
              <FlagIcon />
              <span>{reportLabel}</span>
            </ActionMenuItem>
          {/if}
        </IconContext>
      </ActionMenu>
    {/if}
  </div>
</div>

{#if deleteOpen}
  <DeleteMessageDialog
    bind:open={deleteOpen}
    title={i18n.t('timeline.batchDeleteTitle', { count: caps.deletable.length })}
    description={i18n.t('timeline.batchDeleteExplain', { count: caps.deletable.length })}
    confirmLabel={deleteLabel}
    preview={caps.deletable.length === 1 ? messageCopyText(caps.deletable[0]) : null}
    onConfirm={(reason) => {
      void runDeleteBatch(reason);
    }}
  />
{/if}

{#if forwardOpen}
  <MessageForwardDialog
    bind:open={forwardOpen}
    title={i18n.t('timeline.batchForwardTitle', { count: caps.forwardable.length })}
    metadataLocked={caps.forwardable.some((item) => item.forwarded != null)}
    onForward={(toRoomIds, includeMetadata) => {
      void runForwardBatch(toRoomIds, includeMetadata);
    }}
  />
{/if}

{#if reportOpen}
  <MessageReportDialog
    bind:open={reportOpen}
    title={i18n.t('timeline.batchReportTitle', { count: caps.reportable.length })}
    hint={i18n.t('timeline.batchReportHint', { count: caps.reportable.length })}
    onReport={(reason) => {
      void runReportBatch(reason);
    }}
  />
{/if}

{#if reproxyOpen}
  <MessageReproxyDialog
    bind:open={reproxyOpen}
    title={i18n.t('timeline.batchReproxyTitle', { count: caps.reproxyable.length })}
    personas={personaStore.personas}
    current={reproxyCurrent}
    onChoose={(persona) => {
      void runReproxyBatch(persona);
    }}
  />
{/if}

<style>
  .selection-bar {
    --ghost-active: var(--primary-container-active);
    --ghost-hover: var(--primary-container-hover);

    align-items: center;
    background: var(--primary-container);
    border-bottom: var(--border-width) solid var(--primary-container-line);
    color: var(--primary-on-container);
    display: flex;
    flex: none;
    gap: var(--space-200);
    justify-content: space-between;
    min-height: var(--control-height-400);
    padding: var(--space-100) var(--space-200);
  }

  .selection-start,
  .selection-actions {
    align-items: center;
    display: flex;
    gap: var(--space-100);
    min-width: 0;
  }

  .selection-count {
    align-items: center;
    display: inline-flex;
    font-size: var(--font-size-label);
    font-weight: var(--font-weight-medium);
    gap: var(--space-150);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .selection-bar :global(.selection-danger) {
    color: var(--crit-main);
  }
</style>
