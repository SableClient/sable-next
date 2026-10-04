<script lang="ts">
  import { useCoreClient } from '#lib/core/context.js';
  import { i18n } from '#lib/i18n.js';
  import { formatTime } from '#lib/ui/date-time.js';
  import { agenda, readEntries, startOfDay, type CalendarItem } from './calendar-events.js';

  interface Props {
    roomId: string;
  }

  let { roomId }: Props = $props();

  const core = useCoreClient();

  let items = $state.raw<CalendarItem[]>([]);
  let now = $state(Date.now());

  async function load(): Promise<void> {
    try {
      const view = await core.commands.calendarEntries(roomId);
      items = readEntries(view.entries);
      now = Date.now();
    } catch (error) {
      console.warn('[sable calendar] loading room events failed', error);
    }
  }

  $effect(() => {
    void load();
    const tick = setInterval(() => (now = Date.now()), 60_000);
    const unsubscribe = core.subscribeEvents((event) => {
      if (event.type === 'calendar_changed' && event.room_id === roomId) void load();
    });
    return () => {
      clearInterval(tick);
      unsubscribe();
    };
  });

  let today = $derived(
    agenda(items, startOfDay(now), startOfDay(now, 1)).filter((occurrence) => occurrence.end > now)
  );
  let next = $derived(today[0]);
</script>

{#if next}
  <span class="calendar-row-event">
    {next.item.allDay ? $i18n.t('calendar.allDay') : formatTime(next.start)}
    {next.item.title || $i18n.t('calendar.untitled')}
    {#if today.length > 1}
      · {$i18n.t('calendar.more', { count: today.length - 1 })}
    {/if}
  </span>
{/if}

<style>
  .calendar-row-event {
    font-size: var(--font-size-small);
    font-weight: var(--font-weight-400);
    line-height: var(--line-height-small);
    margin-top: calc(-1 * var(--space-050));
    min-width: 0;
    opacity: var(--opacity-p300);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
