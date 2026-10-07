<script lang="ts">
  import { resolve } from '$app/paths';
  import type { RoomSummary } from '#src/generated/protocol';
  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import { roomLabel, roomPathParam, useRoomList } from '#lib/rooms/room-list.svelte.js';
  import { formatTime } from '#lib/ui/date-time.js';
  import CalendarBlankIcon from 'phosphor-svelte/lib/CalendarBlankIcon';
  import {
    agenda,
    readEntries,
    startOfDay,
    type CalendarItem,
    type Occurrence,
  } from './calendar-events.js';

  const LIMIT = 3;

  interface Props {
    spaceId: string;
    rooms: readonly RoomSummary[];
    onNavigate?: (href: string) => void;
  }

  let { spaceId, rooms, onNavigate }: Props = $props();

  const core = useCoreClient();
  const roomList = useRoomList();

  interface Today {
    room: RoomSummary;
    occurrence: Occurrence;
  }

  let items = $state.raw<Record<string, CalendarItem[]>>({});
  let now = $state(Date.now());
  let roomIds = $derived(rooms.map((room) => room.room_id).join('\n'));

  async function load(roomId: string): Promise<void> {
    try {
      const view = await core.commands.calendarEntries(roomId);
      items = { ...items, [roomId]: readEntries(view.entries) };
      now = Date.now();
    } catch (error) {
      console.warn('[sable calendar] loading space events failed', error);
    }
  }

  $effect(() => {
    const ids = roomIds === '' ? [] : roomIds.split('\n');
    for (const id of ids) void load(id);
    const tick = setInterval(() => (now = Date.now()), 60_000);
    const unsubscribe = core.subscribeEvents((event) => {
      if (event.type === 'calendar_changed' && ids.includes(event.room_id))
        void load(event.room_id);
    });
    return () => {
      clearInterval(tick);
      unsubscribe();
    };
  });

  let today = $derived.by<Today[]>(() => {
    const start = startOfDay(now);
    const end = startOfDay(now, 1);
    return rooms
      .flatMap((room) =>
        agenda(items[room.room_id] ?? [], start, end)
          .filter((occurrence) => occurrence.end > now)
          .map((occurrence) => ({ room, occurrence }))
      )
      .sort((left, right) => left.occurrence.start - right.occurrence.start);
  });
  let shown = $derived(today.slice(0, LIMIT));
</script>

{#if shown.length > 0}
  <section class="space-events" aria-label={$i18n.t('calendar.spaceEvents')}>
    <h3 class="space-events-heading">
      <CalendarBlankIcon aria-hidden="true" />
      <span>{$i18n.t('common.today')}</span>
    </h3>
    <ul class="space-events-list">
      {#each shown as { room, occurrence } (`${room.room_id}|${occurrence.item.eventId}|${String(occurrence.start)}`)}
        {@const href = resolve('/(app)/space/[spaceId]/[roomId]', {
          spaceId,
          roomId: roomPathParam(room, roomList.rooms),
        })}
        <li>
          <a class="space-event selection-layer" {href} onclick={() => onNavigate?.(href)}>
            <span class="space-event-time">
              {occurrence.item.allDay ? $i18n.t('calendar.allDay') : formatTime(occurrence.start)}
            </span>
            <span class="space-event-title">
              {occurrence.item.title || $i18n.t('calendar.untitled')}
            </span>
            {#if rooms.length > 1}
              <span class="space-event-room">{roomLabel(room)}</span>
            {/if}
          </a>
        </li>
      {/each}
    </ul>
    {#if today.length > shown.length}
      <p class="space-events-more">
        {$i18n.t('calendar.more', { count: today.length - shown.length })}
      </p>
    {/if}
  </section>
{/if}

<style>
  .space-events {
    margin-block-end: var(--space-200);
    margin-inline: var(--space-200);
  }

  .space-events-heading {
    align-items: center;
    display: flex;
    font-size: var(--font-size-label);
    font-weight: var(--font-weight-500);
    gap: var(--space-100);
    margin: 0;
    opacity: var(--opacity-p300);
    padding: var(--space-100) var(--space-200);
  }

  .space-events-heading :global(svg) {
    display: block;
    height: var(--icon-size-large);
    width: var(--icon-size-large);
  }

  .space-events-list {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .space-event {
    border-radius: var(--radius);
    color: inherit;
    display: grid;
    gap: 0 var(--space-200);
    grid-template-columns: auto 1fr;
    padding: var(--space-100) var(--space-200);
    text-decoration: none;
  }

  .space-event:focus-visible {
    background: var(--bg-container-hover);
  }

  @media (any-hover: hover) and (any-pointer: fine) {
    .space-event:hover {
      background: var(--bg-container-hover);
    }
  }

  .space-event-time {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
  }

  .space-event-title {
    font-size: var(--font-size-small);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .space-event-room {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    grid-column: 2;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .space-events-more {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    margin: 0;
    padding: 0 var(--space-200);
  }
</style>
