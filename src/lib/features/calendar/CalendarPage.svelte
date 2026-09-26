<script lang="ts">
  import BackIcon from 'phosphor-svelte/lib/CaretLeftIcon';
  import PlusIcon from 'phosphor-svelte/lib/PlusIcon';

  import type { CalendarView, RoomPermissionsView } from '#src/generated/protocol';

  import { useCoreClient } from '#lib/core/context.js';
  import { backToRoomList, trackRoomEntry } from '#lib/features/room/room-navigation.js';
  import { formatDate, formatTime } from '#lib/features/room/timeline-format.js';
  import { i18n } from '#lib/i18n.js';
  import { findRoomByPathId, useRoomList } from '#lib/rooms/room-list.svelte.js';
  import Avatar from '#lib/ui/primitives/Avatar.svelte';
  import Button from '#lib/ui/primitives/Button.svelte';
  import ConfirmDialog from '#lib/ui/primitives/ConfirmDialog.svelte';
  import EmptyState from '#lib/ui/primitives/EmptyState.svelte';
  import PanelHeader from '#lib/ui/primitives/PanelHeader.svelte';
  import PanelHeaderButton from '#lib/ui/primitives/PanelHeaderButton.svelte';
  import Spinner from '#lib/ui/primitives/Spinner.svelte';
  import { toasts } from '#lib/ui/toasts.svelte.js';

  import {
    type CalendarDraft,
    type CalendarItem,
    type Occurrence,
    type RsvpStatus,
    RSVP_EVENT,
    agenda,
    buildEvent,
    readEntry,
    tallyRsvps,
  } from './calendar-events.js';
  import CalendarEventDialog from './CalendarEventDialog.svelte';

  const DAY = 86_400_000;
  const WINDOW = 365 * DAY;
  const STATUSES: readonly RsvpStatus[] = ['accepted', 'tentative', 'declined'];

  interface Props {
    roomId: string;
  }

  let { roomId }: Props = $props();

  const core = useCoreClient();
  trackRoomEntry();
  const roomList = useRoomList();

  let resolvedRoom = $derived(findRoomByPathId(roomList.rooms, roomId));
  let resolvedRoomId = $derived(resolvedRoom?.room_id ?? roomId);
  let roomName = $derived(resolvedRoom?.name ?? roomId);
  let latestEventId = $derived(resolvedRoom?.latest_event?.event_id ?? null);
  let userId = $derived(core.session?.user_id ?? null);

  let view = $state.raw<CalendarView | null>(null);
  let failed = $state(false);
  let permissions = $state<RoomPermissionsView | null>(null);
  let showPast = $state(false);
  let editing = $state<CalendarItem | null>(null);
  let dialogOpen = $state(false);
  let deleting = $state<CalendarItem | null>(null);
  let deleteBusy = $state(false);
  let now = $state(Date.now());

  let items = $derived(
    (view?.entries ?? []).flatMap((entry) => {
      const item = readEntry(entry);
      return item ? [item] : [];
    })
  );
  let occurrences = $derived(
    showPast ? agenda(items, now - WINDOW, now).reverse() : agenda(items, now, now + WINDOW)
  );
  let days = $derived(groupByDay(occurrences));

  $effect(() => {
    void latestEventId;
    void load(resolvedRoomId);
  });

  $effect(() => {
    const activeRoomId = resolvedRoomId;
    let current = true;
    core.commands
      .roomPermissions(activeRoomId)
      .then((next) => {
        if (current) permissions = next;
      })
      .catch(() => {
        if (current) permissions = null;
      });
    return () => {
      current = false;
    };
  });

  async function load(activeRoomId: string): Promise<void> {
    try {
      const next = await core.commands.calendarEntries(activeRoomId);
      if (activeRoomId !== resolvedRoomId) return;
      view = next;
      now = Date.now();
      failed = false;
    } catch (error) {
      console.warn('[sable calendar] loading events failed', error);
      if (activeRoomId === resolvedRoomId) failed = true;
    }
  }

  interface Day {
    key: string;
    label: string;
    list: Occurrence[];
  }

  function groupByDay(list: readonly Occurrence[]): Day[] {
    const groups: Day[] = [];
    for (const occurrence of list) {
      const key = new Date(occurrence.start).toDateString();
      const last = groups.at(-1);
      if (last?.key === key) last.list.push(occurrence);
      else groups.push({ key, label: formatDate(occurrence.start), list: [occurrence] });
    }
    return groups;
  }

  function canChange(item: CalendarItem): boolean {
    if (permissions?.can_post === false) return false;
    return item.sender === userId || (permissions?.can_redact_others ?? false);
  }

  function openNew(): void {
    editing = null;
    dialogOpen = true;
  }

  function openEdit(item: CalendarItem): void {
    editing = item;
    dialogOpen = true;
  }

  async function save(draft: CalendarDraft): Promise<void> {
    const base = editing;
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const event = buildEvent(
      draft,
      base?.raw ?? null,
      base?.uid ?? crypto.randomUUID(),
      Date.now(),
      timeZone
    );
    await core.commands.saveCalendarEvent(resolvedRoomId, event, base?.eventId ?? null);
    await load(resolvedRoomId);
  }

  async function remove(): Promise<void> {
    if (deleting === null) return;
    deleteBusy = true;
    try {
      await core.commands.redact(resolvedRoomId, deleting.eventId);
      deleting = null;
      await load(resolvedRoomId);
    } catch (error) {
      console.warn('[sable calendar] deleting an event failed', error);
      toasts.error($i18n.t('errors.actionFailed'));
    } finally {
      deleteBusy = false;
    }
  }

  async function answer(item: CalendarItem, status: RsvpStatus): Promise<void> {
    try {
      await core.commands.sendRawEvent(resolvedRoomId, RSVP_EVENT, {
        uid: item.uid,
        status,
        'm.relates_to': { event_id: item.eventId },
      });
      await load(resolvedRoomId);
    } catch (error) {
      console.warn('[sable calendar] answering failed', error);
      toasts.error($i18n.t('errors.actionFailed'));
    }
  }

  function timeRange(occurrence: Occurrence): string {
    if (occurrence.item.allDay) return $i18n.t('calendar.allDay');
    const sameDay =
      new Date(occurrence.start).toDateString() === new Date(occurrence.end).toDateString();
    const end = sameDay
      ? formatTime(occurrence.end)
      : `${formatDate(occurrence.end)} ${formatTime(occurrence.end)}`;
    return `${formatTime(occurrence.start)} – ${end}`;
  }
</script>

<svelte:head>
  <title>{roomName}</title>
</svelte:head>

<main class="calendar-page" aria-label={$i18n.t('calendar.label')}>
  <PanelHeader title={roomName} titleSize="h1">
    {#snippet prefix()}
      <PanelHeaderButton label={$i18n.t('timeline.back')} onclick={backToRoomList}>
        <BackIcon />
      </PanelHeaderButton>
      <Avatar
        id={resolvedRoomId}
        src={resolvedRoom?.avatar_url ?? null}
        name={roomName}
        size="small"
      />
    {/snippet}
    {#snippet suffix()}
      {#if permissions?.can_post !== false}
        <PanelHeaderButton label={$i18n.t('calendar.newTitle')} onclick={openNew}>
          <PlusIcon />
        </PanelHeaderButton>
      {/if}
    {/snippet}
  </PanelHeader>

  <div class="calendar-content">
    <div class="calendar-range">
      <Button
        size="small"
        variant={showPast ? 'ghost' : 'secondary'}
        aria-pressed={!showPast}
        onclick={() => (showPast = false)}>{$i18n.t('calendar.upcoming')}</Button
      >
      <Button
        size="small"
        variant={showPast ? 'secondary' : 'ghost'}
        aria-pressed={showPast}
        onclick={() => (showPast = true)}>{$i18n.t('calendar.past')}</Button
      >
    </div>

    {#if view === null}
      {#if failed}
        <EmptyState title={$i18n.t('calendar.loadFailed')} />
      {:else}
        <div class="calendar-loading"><Spinner /></div>
      {/if}
    {:else if days.length === 0}
      <EmptyState title={$i18n.t(showPast ? 'calendar.emptyPast' : 'calendar.empty')} />
    {:else}
      {#each days as day (day.key)}
        <section class="calendar-day">
          <h2>{day.label}</h2>
          <ul>
            {#each day.list as occurrence (`${occurrence.item.eventId}:${String(occurrence.start)}`)}
              {@const item = occurrence.item}
              {@const tally = tallyRsvps(view?.rsvps ?? [], item.uid, userId)}
              <li class="calendar-event">
                <div class="calendar-event-time">{timeRange(occurrence)}</div>
                <div class="calendar-event-body">
                  <h3>{item.title || $i18n.t('calendar.untitled')}</h3>
                  {#if item.location}
                    <p class="calendar-event-location">{item.location}</p>
                  {/if}
                  {#if item.description}
                    <p class="calendar-event-description">{item.description}</p>
                  {/if}
                  <div class="calendar-event-actions">
                    {#each STATUSES as status (status)}
                      <Button
                        size="small"
                        variant={tally.mine === status ? 'primary' : 'secondary'}
                        aria-pressed={tally.mine === status}
                        disabled={permissions?.can_post === false}
                        onclick={() => void answer(item, status)}
                      >
                        {$i18n.t(`calendar.rsvp.${status}`, { count: tally[status] })}
                      </Button>
                    {/each}
                    {#if canChange(item)}
                      <Button size="small" variant="ghost" onclick={() => openEdit(item)}>
                        {$i18n.t('calendar.edit')}
                      </Button>
                      <Button size="small" variant="ghost" onclick={() => (deleting = item)}>
                        {$i18n.t('calendar.delete')}
                      </Button>
                    {/if}
                  </div>
                </div>
              </li>
            {/each}
          </ul>
        </section>
      {/each}
    {/if}
  </div>
</main>

<CalendarEventDialog
  open={dialogOpen}
  item={editing}
  onOpenChange={(open) => (dialogOpen = open)}
  onSave={save}
/>

<ConfirmDialog
  open={deleting !== null}
  onOpenChange={(open) => {
    if (!open) deleting = null;
  }}
  title={$i18n.t('calendar.deleteTitle')}
  description={$i18n.t('calendar.deleteExplain')}
  confirmLabel={$i18n.t('calendar.delete')}
  confirmVariant="danger"
  cancelLabel={$i18n.t('calendar.cancel')}
  busy={deleteBusy}
  onConfirm={() => void remove()}
/>

<style>
  .calendar-page {
    display: flex;
    flex: 1;
    flex-direction: column;
    height: 100%;
    min-height: 0;
    min-width: 0;
  }

  .calendar-content {
    box-sizing: border-box;
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: var(--space-400);
    margin: 0 auto;
    max-width: 60rem;
    min-height: 0;
    overflow-y: auto;
    padding: var(--space-400);
    width: 100%;
  }

  .calendar-range {
    display: flex;
    gap: var(--space-200);
  }

  .calendar-loading {
    display: flex;
    justify-content: center;
    padding: var(--space-600);
  }

  .calendar-day h2 {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    margin: 0 0 var(--space-200);
  }

  .calendar-day ul {
    display: grid;
    gap: var(--space-200);
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .calendar-event {
    background: var(--surface-container);
    border-radius: var(--radii-400);
    display: grid;
    gap: var(--space-300);
    grid-template-columns: 8rem 1fr;
    padding: var(--space-300) var(--space-400);
  }

  .calendar-event-time {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
  }

  .calendar-event-body {
    display: grid;
    gap: var(--space-100);
    min-width: 0;
  }

  .calendar-event h3 {
    font-size: var(--font-size-body);
    margin: 0;
    overflow-wrap: anywhere;
  }

  .calendar-event p {
    margin: 0;
    overflow-wrap: anywhere;
  }

  .calendar-event-location {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
  }

  .calendar-event-description {
    white-space: pre-wrap;
  }

  .calendar-event-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-200);
    padding-top: var(--space-200);
  }

  @media (width < 36rem) {
    .calendar-event {
      grid-template-columns: 1fr;
    }
  }
</style>
