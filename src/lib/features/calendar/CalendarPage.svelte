<script module lang="ts">
  const remembered = { mode: 'agenda' as 'agenda' | 'month', monthStart: null as number | null };
</script>

<script lang="ts">
  import { tick } from 'svelte';

  import BackIcon from 'phosphor-svelte/lib/CaretLeftIcon';
  import NextIcon from 'phosphor-svelte/lib/CaretRightIcon';
  import ListBulletsIcon from 'phosphor-svelte/lib/ListBulletsIcon';
  import PlusIcon from 'phosphor-svelte/lib/PlusIcon';

  import type { CalendarView, MemberView, RoomPermissionsView } from '#src/generated/protocol';

  import { goto } from '$app/navigation';
  import { useCoreClient } from '#lib/core/context.js';
  import { eventTimelinePath } from '#lib/features/room/event-timeline.js';
  import { memberName } from '#lib/features/room/members/members.js';
  import LeaveRoomDialog from '#lib/features/room/LeaveRoomDialog.svelte';
  import RoomHeaderMenu from '#lib/features/room/RoomHeaderMenu.svelte';
  import RoomInviteDialog from '#lib/features/room/RoomInviteDialog.svelte';
  import MessageReportDialog from '#lib/features/room/messages/MessageReportDialog.svelte';
  import { sendReport } from '#lib/features/room/messages/report.js';
  import {
    backToRoomList,
    leaveRoomView,
    trackRoomEntry,
  } from '#lib/features/room/room-navigation.js';
  import RoomSettingsDialog from '#lib/features/room/settings/RoomSettingsDialog.svelte';
  import type { RoomSettingsSectionId } from '#lib/features/room/settings/room-settings-sections.js';
  import { formatDate, formatTime } from '#lib/ui/date-time.js';
  import { currentLocale, i18n } from '#lib/i18n.js';
  import { findRoomByPathId, useRoomList } from '#lib/rooms/room-list.svelte.js';
  import { preferences, readReceiptIsPrivate } from '#lib/settings/preferences.svelte.js';
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
    monthGrid,
    occursOn,
    readEntries,
    startOfDay,
    tallyRsvps,
  } from './calendar-events.js';
  import CalendarEventDialog from './CalendarEventDialog.svelte';

  const DAY = 86_400_000;
  const WINDOW = 365 * DAY;
  const STATUSES: readonly RsvpStatus[] = ['accepted', 'tentative', 'declined'];
  const CHIPS = 3;
  const DOTS = 3;

  function startOfMonth(at: number): number {
    const date = new Date(at);
    return new Date(date.getFullYear(), date.getMonth(), 1).getTime();
  }

  function firstWeekday(): number {
    return { sunday: 0, monday: 1, saturday: 6 }[preferences.weekStart];
  }

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
  let userId = $derived(core.session?.user_id ?? null);

  let view = $state.raw<CalendarView | null>(null);
  let failed = $state(false);
  let permissions = $state<RoomPermissionsView | null>(null);
  let members = $state.raw<MemberView[]>([]);
  let showPast = $state(false);
  let mode = $state(remembered.mode);
  let monthStart = $state(remembered.monthStart ?? startOfMonth(Date.now()));
  let pickedDay = $state<number | null>(null);
  let newDay = $state<number | null>(null);
  let listElement = $state<HTMLElement | null>(null);
  let gridElement = $state<HTMLElement | null>(null);
  let editing = $state.raw<CalendarItem | null>(null);
  let dialogOpen = $state(false);
  let deleting = $state<CalendarItem | null>(null);
  let deleteBusy = $state(false);
  let now = $state(Date.now());
  let settingsOpen = $state(false);
  let settingsSection = $state<RoomSettingsSectionId | null>(null);
  let inviteOpen = $state(false);
  let reportOpen = $state(false);
  let leaveOpen = $state(false);

  let items = $derived(readEntries(view?.entries ?? []));
  let occurrences = $derived(
    showPast ? agenda(items, now - WINDOW, now).reverse() : agenda(items, now, now + WINDOW)
  );
  $effect(() => {
    remembered.mode = mode;
    remembered.monthStart = monthStart;
  });

  let grid = $derived(monthGrid(monthStart, firstWeekday()));
  let gridOccurrences = $derived(
    agenda(items, grid[0] ?? monthStart, startOfDay(grid.at(-1) ?? monthStart) + 2 * DAY)
  );
  let activeDay = $derived(
    pickedDay ?? (startOfMonth(now) === monthStart ? startOfDay(now) : monthStart)
  );
  let dayOccurrences = $derived(gridOccurrences.filter((entry) => occursOn(entry, activeDay)));
  let weeks = $derived(
    Array.from({ length: grid.length / 7 }, (_, index) => grid.slice(index * 7, index * 7 + 7))
  );
  let days = $derived(
    mode === 'month'
      ? dayOccurrences.length === 0
        ? []
        : [
            {
              key: String(activeDay),
              label: new Date(activeDay).toLocaleDateString(currentLocale(), {
                weekday: 'long',
                day: 'numeric',
                month: 'long',
              }),
              list: dayOccurrences,
            },
          ]
      : groupByDay(occurrences)
  );
  let emptyKey = $derived(
    mode === 'month' ? 'calendar.emptyDay' : showPast ? 'calendar.emptyPast' : 'calendar.empty'
  );

  $effect(() => {
    const activeRoomId = resolvedRoomId;
    void load(activeRoomId);
    return core.subscribeEvents((event) => {
      if (event.type === 'calendar_changed' && event.room_id === activeRoomId)
        void load(activeRoomId);
    });
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

  $effect(() => {
    const activeRoomId = resolvedRoomId;
    let current = true;
    core.commands
      .roomMembers(activeRoomId)
      .then((next) => {
        if (current) members = next;
      })
      .catch((error: unknown) => {
        console.warn('[sable calendar] loading members failed', error);
      });
    return () => {
      current = false;
    };
  });

  function people(userIds: readonly string[]): string {
    return new Intl.ListFormat(currentLocale(), { type: 'conjunction' }).format(
      userIds.map((userId) => memberName(members, userId))
    );
  }

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

  function chips(day: number): Occurrence[] {
    return gridOccurrences.filter((entry) => occursOn(entry, day));
  }

  function moveMonth(by: number): void {
    const date = new Date(monthStart);
    monthStart = new Date(date.getFullYear(), date.getMonth() + by, 1).getTime();
    pickedDay = null;
  }

  function goToday(): void {
    monthStart = startOfMonth(Date.now());
    pickedDay = startOfDay(Date.now());
  }

  function mineOn(entry: Occurrence): RsvpStatus | null {
    return tallyRsvps(view?.rsvps ?? [], entry.item.uid, entry.recurrenceId, userId).mine;
  }

  function dayLabel(day: number, count: number): string {
    const date = new Date(day).toLocaleDateString(currentLocale(), { dateStyle: 'full' });
    return count === 0 ? date : $i18n.t('calendar.dayEvents', { date, count });
  }

  function pickDay(day: number): void {
    pickedDay = day;
    void tick().then(() => listElement?.scrollIntoView({ block: 'nearest' }));
  }

  async function focusDay(day: number): Promise<void> {
    const date = new Date(day);
    if (date.getMonth() !== new Date(monthStart).getMonth()) monthStart = startOfMonth(day);
    pickedDay = day;
    await tick();
    gridElement?.querySelector<HTMLElement>(`[data-day="${String(day)}"]`)?.focus();
  }

  function onGridKey(event: KeyboardEvent, day: number): void {
    const date = new Date(day);
    const shift = (days: number, months = 0): number =>
      new Date(date.getFullYear(), date.getMonth() + months, date.getDate() + days).getTime();
    const weekday = (date.getDay() - firstWeekday() + 7) % 7;
    const target: Record<string, number> = {
      ArrowLeft: shift(-1),
      ArrowRight: shift(1),
      ArrowUp: shift(-7),
      ArrowDown: shift(7),
      Home: shift(-weekday),
      End: shift(6 - weekday),
      PageUp: shift(0, -1),
      PageDown: shift(0, 1),
    };
    if (event.key === 'Enter' && permissions?.can_post !== false) {
      event.preventDefault();
      openNew(day);
      return;
    }
    const next = target[event.key];
    if (next === undefined) return;
    event.preventDefault();
    void focusDay(next);
  }

  function openNew(day: number | null = null): void {
    newDay = day;
    editing = null;
    dialogOpen = true;
  }

  function openSettings(section: RoomSettingsSectionId | null = null): void {
    settingsSection = section;
    settingsOpen = true;
  }

  function markRead(): void {
    void core.commands
      .markRead(resolvedRoomId, null, readReceiptIsPrivate())
      .catch((error: unknown) => {
        console.warn('[sable calendar] mark as read failed', error);
        toasts.error($i18n.t('errors.actionFailed'));
      });
  }

  function markUnread(): void {
    void core.commands.markUnread(resolvedRoomId).catch((error: unknown) => {
      console.warn('[sable calendar] mark as unread failed', error);
      toasts.error($i18n.t('errors.actionFailed'));
    });
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

  async function answer(occurrence: Occurrence, status: RsvpStatus): Promise<void> {
    const item = occurrence.item;
    try {
      await core.commands.sendRawEvent(resolvedRoomId, RSVP_EVENT, {
        uid: item.uid,
        ...(occurrence.recurrenceId === null ? {} : { recurrenceId: occurrence.recurrenceId }),
        status,
        'm.relates_to': { rel_type: 'm.reference', event_id: item.eventId },
      });
      await load(resolvedRoomId);
    } catch (error) {
      console.warn('[sable calendar] answering failed', error);
      toasts.error($i18n.t('errors.actionFailed'));
    }
  }

  function timeRange(occurrence: Occurrence): string {
    if (occurrence.item.allDay) {
      const last = occurrence.end - 1;
      return new Date(occurrence.start).toDateString() === new Date(last).toDateString()
        ? $i18n.t('calendar.allDay')
        : $i18n.t('calendar.allDayUntil', { date: formatDate(last) });
    }
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

<main class="calendar-page" aria-label={$i18n.t('calendar.label')} data-inset-owner="top">
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
      {#if preferences.developerTools}
        <PanelHeaderButton
          label={$i18n.t('timeline.eventTimeline')}
          onclick={() => {
            void goto(eventTimelinePath(resolvedRoomId));
          }}
        >
          <ListBulletsIcon />
        </PanelHeaderButton>
      {/if}
      {#if permissions?.can_post !== false}
        <PanelHeaderButton label={$i18n.t('calendar.newTitle')} onclick={() => openNew()}>
          <PlusIcon />
        </PanelHeaderButton>
      {/if}
      <RoomHeaderMenu
        room={resolvedRoom ?? null}
        canInvite={permissions?.can_invite ?? false}
        compact
        onMarkRead={markRead}
        onMarkUnread={markUnread}
        onInvite={() => (inviteOpen = true)}
        onMembers={() => openSettings('members')}
        onSettings={() => openSettings()}
        onReport={() => (reportOpen = true)}
        onLeave={() => (leaveOpen = true)}
      />
    {/snippet}
  </PanelHeader>

  <div class="calendar-content">
    <div class="calendar-range">
      <div class="calendar-segment" role="group" aria-label={$i18n.t('calendar.view')}>
        <Button
          size="small"
          variant={mode === 'agenda' ? 'primary' : 'ghost'}
          aria-pressed={mode === 'agenda'}
          onclick={() => (mode = 'agenda')}>{$i18n.t('calendar.viewAgenda')}</Button
        >
        <Button
          size="small"
          variant={mode === 'month' ? 'primary' : 'ghost'}
          aria-pressed={mode === 'month'}
          onclick={() => (mode = 'month')}>{$i18n.t('calendar.viewMonth')}</Button
        >
      </div>
      {#if mode === 'agenda'}
        <div class="calendar-segment" role="group" aria-label={$i18n.t('calendar.range')}>
          <Button
            size="small"
            variant={showPast ? 'ghost' : 'primary'}
            aria-pressed={!showPast}
            onclick={() => (showPast = false)}>{$i18n.t('calendar.upcoming')}</Button
          >
          <Button
            size="small"
            variant={showPast ? 'primary' : 'ghost'}
            aria-pressed={showPast}
            onclick={() => (showPast = true)}>{$i18n.t('calendar.past')}</Button
          >
        </div>
      {/if}
    </div>

    {#if mode === 'month'}
      <div class="calendar-month-nav">
        <PanelHeaderButton label={$i18n.t('calendar.previousMonth')} onclick={() => moveMonth(-1)}>
          <BackIcon />
        </PanelHeaderButton>
        <h2 class="calendar-month-title">
          {new Date(monthStart).toLocaleDateString(currentLocale(), {
            month: 'long',
            year: 'numeric',
          })}
        </h2>
        <PanelHeaderButton label={$i18n.t('calendar.nextMonth')} onclick={() => moveMonth(1)}>
          <NextIcon />
        </PanelHeaderButton>
        <Button size="small" variant="ghost" onclick={goToday}>{$i18n.t('calendar.today')}</Button>
      </div>
      <div
        class="calendar-grid"
        role="grid"
        aria-label={new Date(monthStart).toLocaleDateString(currentLocale(), {
          month: 'long',
          year: 'numeric',
        })}
        bind:this={gridElement}
      >
        <div class="calendar-week" role="row">
          {#each weeks[0] ?? [] as weekday (weekday)}
            <div class="calendar-weekday" role="columnheader">
              {new Date(weekday).toLocaleDateString(currentLocale(), { weekday: 'short' })}
            </div>
          {/each}
        </div>
        {#each weeks as week (week[0])}
          <div class="calendar-week" role="row">
            {#each week as day (day)}
              {@const inMonth = new Date(day).getMonth() === new Date(monthStart).getMonth()}
              {@const found = chips(day)}
              <button
                type="button"
                role="gridcell"
                class="calendar-cell"
                class:outside={!inMonth}
                class:today={day === startOfDay(now)}
                data-day={day}
                tabindex={day === activeDay ? 0 : -1}
                aria-selected={day === activeDay}
                aria-current={day === startOfDay(now) ? 'date' : undefined}
                aria-label={dayLabel(day, found.length)}
                onclick={() => pickDay(day)}
                ondblclick={() => {
                  if (permissions?.can_post !== false) openNew(day);
                }}
                onkeydown={(event) => onGridKey(event, day)}
              >
                <span class="calendar-cell-number">{new Date(day).getDate()}</span>
                {#each found.slice(0, CHIPS) as entry (`${entry.item.eventId}:${String(entry.start)}`)}
                  <span class="calendar-chip" class:declined={mineOn(entry) === 'declined'}>
                    {#if !entry.item.allDay}<span class="calendar-chip-time"
                        >{formatTime(entry.start)}</span
                      >{/if}
                    {entry.item.title || $i18n.t('calendar.untitled')}
                  </span>
                {/each}
                {#if found.length > 0}
                  <span class="calendar-dots" aria-hidden="true">
                    {#each found.slice(0, DOTS) as entry (`${entry.item.eventId}:${String(entry.start)}`)}
                      <span class="calendar-dot"></span>
                    {/each}
                  </span>
                {/if}
                {#if found.length > CHIPS}
                  <span class="calendar-more"
                    >{$i18n.t('calendar.more', { count: found.length - CHIPS })}</span
                  >
                {/if}
              </button>
            {/each}
          </div>
        {/each}
      </div>
    {/if}

    <div class="calendar-list" bind:this={listElement}>
      {#if view === null}
        {#if failed}
          <EmptyState title={$i18n.t('calendar.loadFailed')}>
            {#snippet actions()}
              <Button size="small" onclick={() => void load(resolvedRoomId)}>
                {$i18n.t('calendar.retry')}
              </Button>
            {/snippet}
          </EmptyState>
        {:else}
          <div class="calendar-loading"><Spinner /></div>
        {/if}
      {:else if days.length === 0}
        {#if mode === 'month'}
          <p class="calendar-day-empty">{$i18n.t(emptyKey)}</p>
        {:else}
          <EmptyState title={$i18n.t(emptyKey)} />
        {/if}
      {:else}
        {#each days as day (day.key)}
          <section class="calendar-day">
            <h2>{day.label}</h2>
            <ul>
              {#each day.list as occurrence (`${occurrence.item.eventId}:${String(occurrence.start)}`)}
                {@const item = occurrence.item}
                {@const tally = tallyRsvps(
                  view?.rsvps ?? [],
                  item.uid,
                  occurrence.recurrenceId,
                  userId
                )}
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
                    {#if STATUSES.some((status) => tally.people[status].length > 0)}
                      <dl class="calendar-event-people">
                        {#each STATUSES as status (status)}
                          {#if tally.people[status].length > 0}
                            <div>
                              <dt>{$i18n.t(`calendar.people.${status}`)}</dt>
                              <dd>{people(tally.people[status])}</dd>
                            </div>
                          {/if}
                        {/each}
                      </dl>
                    {/if}
                    <div class="calendar-event-actions">
                      {#each STATUSES as status (status)}
                        <Button
                          size="small"
                          variant={tally.mine === status ? 'primary' : 'secondary'}
                          aria-pressed={tally.mine === status}
                          disabled={permissions?.can_post === false}
                          onclick={() => void answer(occurrence, status)}
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
  </div>
</main>

<RoomSettingsDialog
  open={settingsOpen}
  room={resolvedRoom ?? null}
  initialSection={settingsSection}
  onOpenChange={(open) => (settingsOpen = open)}
/>
<RoomInviteDialog
  open={inviteOpen}
  room={resolvedRoom ?? null}
  onOpenChange={(open) => (inviteOpen = open)}
/>
<MessageReportDialog
  bind:open={reportOpen}
  title={$i18n.t('room.reportTitle')}
  hint={$i18n.t('room.reportHint')}
  onReport={(reason) => {
    const target = resolvedRoomId;
    void sendReport(() => core.commands.reportRoom(target, reason ?? ''));
  }}
/>
<LeaveRoomDialog
  open={leaveOpen}
  room={resolvedRoom ?? null}
  onOpenChange={(open) => (leaveOpen = open)}
  onLeft={leaveRoomView}
/>

<CalendarEventDialog
  open={dialogOpen}
  item={editing}
  initialDay={newDay}
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
    flex-wrap: wrap;
    gap: var(--space-200);
  }

  .calendar-segment {
    background: var(--surface-container);
    border-radius: var(--radii-400);
    display: inline-flex;
    gap: var(--space-100);
    padding: var(--space-100);
  }

  .calendar-month-nav {
    align-items: center;
    display: flex;
    gap: var(--space-200);
  }

  .calendar-month-title {
    flex: 1;
    font-size: var(--font-size-body);
    margin: 0;
    text-align: center;
  }

  .calendar-grid {
    display: grid;
    gap: var(--space-100);
  }

  .calendar-week {
    display: grid;
    gap: var(--space-100);
    grid-template-columns: repeat(7, minmax(0, 1fr));
  }

  .calendar-weekday {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    text-align: center;
  }

  .calendar-cell {
    align-items: stretch;
    background: var(--surface-container);
    border: 1px solid transparent;
    border-radius: var(--radii-400);
    color: var(--surface-on-container);
    cursor: pointer;
    display: flex;
    flex-direction: column;
    font: inherit;
    gap: var(--space-100);
    min-height: 5.5rem;
    min-width: 0;
    overflow: hidden;
    padding: var(--space-100) var(--space-200);
    text-align: start;
  }

  .calendar-cell:hover {
    background: var(--surface-container-hover);
  }

  .calendar-cell:focus-visible {
    outline: 2px solid var(--surface-on-container);
    outline-offset: 1px;
  }

  .calendar-cell.outside {
    color: var(--surface-var-on-container);
  }

  .calendar-cell[aria-selected='true'] {
    background: var(--surface-container-active);
    border-color: var(--surface-on-container);
  }

  .calendar-cell-number {
    align-items: center;
    align-self: flex-start;
    border-radius: var(--radii-300);
    display: inline-flex;
    font-size: var(--font-size-small);
    justify-content: center;
    min-height: 1.5rem;
    min-width: 1.5rem;
  }

  .calendar-cell.today .calendar-cell-number {
    background: var(--primary-main);
    color: var(--primary-on-main);
    font-weight: 700;
  }

  .calendar-chip-time {
    color: var(--surface-var-on-container);
  }

  .calendar-chip.declined {
    color: var(--surface-var-on-container);
    text-decoration: line-through;
  }

  .calendar-dots {
    display: none;
    gap: var(--space-100);
    justify-content: center;
  }

  .calendar-dot {
    background: var(--surface-on-container);
    border-radius: 50%;
    height: 0.375rem;
    width: 0.375rem;
  }

  .calendar-list {
    display: flex;
    flex-direction: column;
    gap: var(--space-400);
  }

  .calendar-day-empty {
    color: var(--surface-var-on-container);
    font-size: var(--font-size-small);
    margin: 0;
  }

  .calendar-chip,
  .calendar-more {
    font-size: var(--font-size-small);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .calendar-chip {
    background: var(--surface-var-container);
    border-radius: var(--radii-200);
    padding: 0 var(--space-100);
  }

  .calendar-more {
    color: var(--surface-var-on-container);
  }

  .calendar-loading {
    display: flex;
    justify-content: center;
    padding: var(--space-600);
  }

  .calendar-day h2 {
    font-size: var(--font-size-body);
    font-weight: 700;
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
    color: var(--surface-on-container);
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

  .calendar-event-people {
    display: grid;
    font-size: var(--font-size-small);
    gap: var(--space-100);
    margin: 0;
  }

  .calendar-event-people div {
    display: flex;
    gap: var(--space-200);
  }

  .calendar-event-people dt {
    color: var(--surface-var-on-container);
    flex: 0 0 auto;
  }

  .calendar-event-people dd {
    margin: 0;
    overflow-wrap: anywhere;
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

    .calendar-cell {
      min-height: 3rem;
      padding: var(--space-100);
    }

    .calendar-chip,
    .calendar-more {
      display: none;
    }

    .calendar-dots {
      display: flex;
    }
  }
</style>
