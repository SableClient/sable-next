<script lang="ts">
  import type { RoomSummary } from '@/generated/RoomSummary';
  import { SvelteSet } from 'svelte/reactivity';
  import ChecksIcon from 'phosphor-svelte/lib/ChecksIcon';

  import { resolve } from '$app/paths';
  import { useCoreClient } from '$lib/core/context';
  import { i18n } from '$lib/i18n';
  import { formatDate, formatTime, initials } from '$lib/features/room/timeline-format';
  import { notificationCount, notifications, type NotificationFilter, senderName } from './inbox';
  import { roomPathParam, useRoomList } from '$lib/rooms/room-list.svelte';
  import Avatar from '$lib/ui/primitives/Avatar.svelte';
  import IconButton from '$lib/ui/primitives/IconButton.svelte';

  interface Props {
    filter: NotificationFilter;
    onFilter: (filter: NotificationFilter) => void;
  }

  let { filter, onFilter }: Props = $props();
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

  function roomHref(room: RoomSummary): string {
    const param = roomPathParam(room);
    return room.is_direct
      ? resolve('/(app)/direct/[roomId]', { roomId: param })
      : resolve('/(app)/home/[roomId]', { roomId: param });
  }

  function roomName(room: RoomSummary): string {
    return room.name ?? room.room_id;
  }

  /** In a chat the sender is the room, so naming them again reads as noise. */
  function preview(room: RoomSummary): string | null {
    const latest = room.latest_event;
    if (!latest) return null;
    if (room.is_direct || !latest.sender) return latest.body;
    return `${senderName(latest.sender)}: ${latest.body}`;
  }

  function when(timestamp: number): string {
    const sameDay = new Date(timestamp).toDateString() === new Date().toDateString();
    return sameDay ? formatTime(timestamp) : formatDate(timestamp);
  }

  // The receipt clears the counts, and the room list pushes the row out.
  async function markRead(room: RoomSummary, eventId: string): Promise<void> {
    if (marking.has(room.room_id)) return;
    marking.add(room.room_id);
    try {
      await core.markRead(room.room_id, eventId);
    } catch (error) {
      console.warn('[sable inbox] marking the room read failed', error);
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
        <button
          class={['filter', { active: value === filter }]}
          type="button"
          aria-pressed={value === filter}
          onclick={() => {
            onFilter(value);
          }}
        >
          {$i18n.t(filterLabels[value])}
        </button>
      {/each}
    </div>
  </div>

  {#if rooms.length === 0}
    <p class="empty">{$i18n.t('inbox.notificationsEmpty')}</p>
  {:else}
    <ul class="feed">
      {#each rooms as room (room.room_id)}
        {@const name = roomName(room)}
        {@const count = notificationCount(room)}
        {@const line = preview(room)}
        {@const readable = room.latest_event?.event_id ?? null}
        <li>
          <!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- roomHref resolves the route itself -->
          <a class="row" href={roomHref(room)}>
            <Avatar
              src={room.avatar_url}
              initials={initials(name)}
              shape={room.is_direct ? 'person' : 'room'}
            />
            <span class="body">
              <span class="head">
                <span class="name">{name}</span>
                {#if room.latest_event?.timestamp}
                  <span class="when">{when(room.latest_event.timestamp)}</span>
                {/if}
              </span>
              <span class="foot">
                <span class="preview">{line ?? ''}</span>
                <span
                  class={['count', { highlight: room.highlight > 0 }]}
                  aria-label={$i18n.t('timeline.unreadCount', { count })}>{count}</span
                >
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
    gap: var(--space-1) var(--space-3);
    justify-content: space-between;
    margin-bottom: var(--space-2);
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
    gap: var(--space-compact);
  }

  .filter {
    background: transparent;
    border: 0;
    border-radius: var(--radius-pill);
    color: var(--sable-surface-var-on-container);
    cursor: pointer;
    font: inherit;
    font-size: var(--font-size-small);
    min-height: var(--control-height-small);
    padding: 0 var(--space-2);
  }

  .filter:hover {
    background: var(--sable-surface-var-container-hover);
    color: var(--sable-bg-on-container);
  }

  .filter.active {
    background: var(--sable-primary-container);
    color: var(--sable-primary-on-container);
    font-weight: var(--font-weight-medium);
  }

  .filter.active:hover {
    background: var(--sable-primary-container-hover);
    color: var(--sable-primary-on-container);
  }

  .filter:focus-visible {
    outline: var(--focus-ring-width) solid var(--sable-focus-ring);
    outline-offset: var(--focus-ring-offset);
  }

  .feed {
    background: var(--sable-bg-container);
    border: 1px solid var(--sable-bg-container-line);
    border-radius: var(--radius-card);
    list-style: none;
    margin: 0;
    overflow: hidden;
    padding: 0;
  }

  li {
    align-items: center;
    display: flex;
    gap: var(--space-1);
    padding-right: var(--space-2);
  }

  li + li {
    border-top: 1px solid var(--sable-bg-container-line);
  }

  li:hover {
    background: var(--sable-bg-container-hover);
  }

  .row {
    align-items: center;
    color: inherit;
    display: flex;
    flex: 1;
    gap: var(--space-2);
    min-width: 0;
    padding: var(--space-2) var(--space-3);
    text-decoration: none;
  }

  .row:focus-visible {
    outline: var(--focus-ring-width) solid var(--sable-focus-ring);
    outline-offset: calc(var(--focus-ring-width) * -1);
  }

  .body {
    display: grid;
    flex: 1;
    gap: var(--space-compact);
    min-width: 0;
  }

  .head,
  .foot {
    align-items: baseline;
    display: flex;
    gap: var(--space-2);
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
    padding: 0 var(--space-compact);
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
    .filter {
      transition: background var(--motion-fast) var(--motion-easing-standard);
    }
  }
</style>
