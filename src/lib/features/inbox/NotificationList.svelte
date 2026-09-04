<script lang="ts">
  import type { RoomSummary } from '#src/generated/RoomSummary';
  import { SvelteSet } from 'svelte/reactivity';
  import ChecksIcon from 'phosphor-svelte/lib/ChecksIcon';

  import { useCoreClient } from '#lib/core/context.js';
  import { toasts } from '#lib/ui/toasts.svelte.js';
  import { i18n } from '#lib/i18n.js';
  import { formatMessageTimestamp } from '#lib/features/room/timeline-format.js';
  import { notificationCount, notifications, type NotificationFilter, senderName } from './inbox';
  import { roomSectionPath } from '#lib/rooms/permalink.js';
  import { useRoomList } from '#lib/rooms/room-list.svelte.js';
  import { readReceiptIsPrivate } from '#lib/settings/preferences.svelte.js';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import IconButton from '#lib/ui/primitives/IconButton.svelte';
  import UnreadBadge from '#lib/ui/primitives/UnreadBadge.svelte';

  interface Props {
    filter: NotificationFilter;
    onFilter: (filter: NotificationFilter) => void;
    limit?: number;
  }

  let { filter, onFilter, limit }: Props = $props();
  const core = useCoreClient();
  const roomList = useRoomList();
  const headingId = $props.id();
  const marking = new SvelteSet<string>();
  const filters: readonly NotificationFilter[] = ['all', 'mentions', 'direct'];
  const filterLabels: Record<NotificationFilter, string> = {
    all: 'inbox.filterAll',
    mentions: 'inbox.filterMentions',
    direct: 'inbox.filterDirect',
  };

  let rooms = $derived(notifications(roomList.rooms, filter));
  let visibleRooms = $derived(limit === undefined ? rooms : rooms.slice(0, limit));

  function roomHref(room: RoomSummary): string {
    return roomSectionPath(roomList.rooms, room.room_id);
  }

  function roomName(room: RoomSummary): string {
    return room.name ?? room.room_id;
  }

  function preview(room: RoomSummary): string | null {
    const latest = room.latest_event;
    if (!latest) return null;
    if (room.is_direct || !latest.sender) return latest.body;
    return `${senderName(latest.sender)}: ${latest.body}`;
  }

  async function markRead(room: RoomSummary, eventId: string): Promise<void> {
    if (marking.has(room.room_id)) return;
    marking.add(room.room_id);
    try {
      await core.commands.markRead(room.room_id, eventId, readReceiptIsPrivate());
    } catch (error) {
      console.warn('[sable inbox] marking the room read failed', error);
      toasts.error($i18n.t('errors.actionFailed'));
    } finally {
      marking.delete(room.room_id);
    }
  }
</script>

<section aria-labelledby={headingId}>
  <div class="header">
    <h2 id={headingId}>{$i18n.t('inbox.notifications')}</h2>
    <div class="filters" role="group" aria-label={$i18n.t('inbox.filterLabel')}>
      {#each filters as value (value)}
        <Button
          variant="ghost"
          size="small"
          class="filter sable-choice"
          aria-pressed={value === filter}
          onclick={() => {
            onFilter(value);
          }}
        >
          {$i18n.t(filterLabels[value])}
        </Button>
      {/each}
    </div>
  </div>

  {#if visibleRooms.length === 0}
    <p class="empty">{$i18n.t('inbox.notificationsEmpty')}</p>
  {:else}
    <ul class="feed">
      {#each visibleRooms as room (room.room_id)}
        {@const name = roomName(room)}
        {@const count = notificationCount(room)}
        {@const line = preview(room)}
        {@const readable = room.latest_event?.event_id ?? null}
        <li>
          <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- roomHref resolves the route itself -->
          <a class="row" href={roomHref(room)}>
            <Avatar src={room.avatar_url} {name} />
            <span class="body">
              <span class="head">
                <span class="name">{name}</span>
                {#if room.latest_event?.timestamp}
                  <span class="when">{formatMessageTimestamp(room.latest_event.timestamp)}</span>
                {/if}
              </span>
              <span class="foot">
                <span class="preview">{line ?? ''}</span>
                {#if count > 0}
                  <span
                    class={['count', { highlight: room.highlight > 0 }]}
                    aria-label={$i18n.t('timeline.unreadCount', { count })}>{count}</span
                  >
                {:else}
                  <UnreadBadge
                    counts={{ unread: 0, highlight: 0, marked: true }}
                    role="img"
                    aria-label={$i18n.t('nav.markedUnread')}
                  />
                {/if}
              </span>
            </span>
          </a>
          {#if readable}
            <IconButton
              class="mark-read"
              variant="ghost"
              size="small"
              disabled={marking.has(room.room_id)}
              label={$i18n.t('inbox.markRead', { room: name })}
              onclick={() => {
                void markRead(room, readable);
              }}
            >
              <ChecksIcon />
            </IconButton>
          {/if}
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .header {
    align-items: baseline;
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-200) var(--space-400);
    justify-content: space-between;
    margin-bottom: var(--space-300);
  }

  h2 {
    color: var(--sable-surface-var-on-container);
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-bold);
    letter-spacing: 0.08em;
    margin: 0;
    text-transform: uppercase;
  }

  .filters {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-100);
  }

  :global(.filter) {
    background: transparent;
    border-color: transparent;
    border-radius: var(--radius-pill);
    color: var(--sable-surface-var-on-container);
    font-size: var(--font-size-small);
    padding: 0 var(--space-300);
  }

  :global(.filter:hover:not(:disabled)) {
    background: var(--sable-surface-var-container-hover);
    color: var(--sable-bg-on-container);
  }

  .feed {
    background: var(--sable-bg-container);
    border: var(--border-width) solid var(--sable-bg-container-line);
    border-radius: var(--radius);
    list-style: none;
    margin: 0;
    overflow: hidden;
    padding: 0;
  }

  li {
    align-items: center;
    display: flex;
    gap: var(--space-200);
    padding-right: var(--space-300);
  }

  li + li {
    border-top: var(--border-width) solid var(--sable-bg-container-line);
  }

  li:hover {
    background: var(--sable-bg-container-hover);
  }

  .row {
    align-items: center;
    color: inherit;
    display: flex;
    flex: 1;
    gap: var(--space-300);
    min-width: 0;
    padding: var(--space-300) var(--space-400);
    text-decoration: none;
  }

  .row:focus-visible {
    outline: var(--focus-ring-width) solid var(--sable-focus-ring);
    outline-offset: calc(var(--focus-ring-width) * -1);
  }

  .body {
    display: grid;
    flex: 1;
    gap: var(--space-100);
    min-width: 0;
  }

  .head,
  .foot {
    align-items: baseline;
    display: flex;
    gap: var(--space-300);
    min-width: 0;
  }

  .name {
    flex: 1;
    font-weight: var(--font-weight-medium);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .when {
    color: var(--sable-surface-var-on-container);
    flex: 0 0 auto;
    font-size: var(--font-size-small);
    font-variant-numeric: tabular-nums;
  }

  .preview {
    color: var(--sable-surface-var-on-container);
    flex: 1;
    font-size: var(--font-size-small);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .count {
    background: var(--sable-surface-var-container);
    border-radius: var(--radius-pill);
    color: var(--sable-surface-var-on-container);
    flex: 0 0 auto;
    font-size: var(--font-size-small);
    font-variant-numeric: tabular-nums;
    font-weight: var(--font-weight-bold);
    min-width: 1.375rem;
    padding: 0 var(--space-100);
    text-align: center;
  }

  .count.highlight {
    background: var(--sable-primary-main);
    color: var(--sable-primary-on-main);
  }

  .empty {
    color: var(--sable-surface-var-on-container);
    margin: 0;
    text-align: center;
  }

  @media (prefers-reduced-motion: no-preference) {
    .row,
    :global(.filter) {
      transition: background var(--motion-fast) var(--motion-easing-standard);
    }
  }
</style>
