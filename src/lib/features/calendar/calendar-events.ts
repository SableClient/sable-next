import type {
  CalendarEntryView,
  CalendarItem,
  Frequency,
  RsvpStatusView,
} from '#src/generated/protocol';

import { buildCalendarEvent, calendarWallTimes, readCalendarEntries } from '#lib/model/model.js';

export type { CalendarItem, Frequency } from '#src/generated/protocol';
export {
  formatDuration,
  parseDuration,
  readCalendarEntries as readEntries,
  tallyRsvps,
} from '#lib/model/model.js';

export const CALENDAR_ROOM_TYPE = 'chat.commet.calendar';
export const RSVP_EVENT = 'moe.sable.calendar.rsvp';

export type RsvpStatus = RsvpStatusView;

const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;
const DAY = 86_400_000;

export interface Occurrence {
  item: CalendarItem;
  recurrenceId: string | null;
  start: number;
  end: number;
}

function groups(match: RegExpExecArray): [number, number, number, number, number, number] {
  const parts: (string | undefined)[] = match.slice(1);
  const at = (index: number): number => Number(parts[index] ?? 0);
  return [at(0), at(1), at(2), at(3), at(4), at(5)];
}

function zoneOffset(utc: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(utc);
  const part = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((entry) => entry.type === type)?.value ?? 0);
  const asUtc = Date.UTC(
    part('year'),
    part('month') - 1,
    part('day'),
    part('hour'),
    part('minute'),
    part('second')
  );
  return asUtc - Math.floor(utc / 1000) * 1000;
}

export function localToEpoch(local: string, timeZone: string | null): number | null {
  const match = LOCAL_DATE_TIME.exec(local);
  if (!match) return null;
  const [year, month, day, hour, minute, second] = groups(match);
  if (timeZone === null) return new Date(year, month - 1, day, hour, minute, second).getTime();
  const wall = Date.UTC(year, month - 1, day, hour, minute, second);
  try {
    const guess = wall - zoneOffset(wall, timeZone);
    return wall - zoneOffset(guess, timeZone);
  } catch {
    return null;
  }
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

export function epochToLocal(epoch: number): string {
  const at = new Date(epoch);
  return `${String(at.getFullYear())}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${pad(at.getHours())}:${pad(at.getMinutes())}:00`;
}

/** A wall time past every start before `to` in `timeZone`, with a day to spare for its offset. */
function wallTimeAfter(to: number, timeZone: string | null): string | null {
  const after = to + DAY;
  if (timeZone === null) return epochToLocal(after);
  try {
    return new Date(after + zoneOffset(after, timeZone)).toISOString().slice(0, 19);
  } catch {
    return null;
  }
}

function occurrences(item: CalendarItem, from: number, to: number): Occurrence[] {
  const before = wallTimeAfter(to, item.time_zone);
  if (before === null) return [];
  const found: Occurrence[] = [];
  const until = item.recurrence?.until
    ? localToEpoch(item.recurrence.until.slice(0, 19), item.time_zone)
    : null;
  for (const local of calendarWallTimes(item, before)) {
    const start = localToEpoch(local, item.time_zone);
    if (start === null || start >= to || (until !== null && start > until)) break;
    const end = start + item.duration_ms;
    if (end >= from)
      found.push({ item, recurrenceId: item.recurrence === null ? null : local, start, end });
  }
  return found;
}

export function readEntry(entry: CalendarEntryView): CalendarItem | null {
  return readCalendarEntries([entry])[0] ?? null;
}

export function startOfDay(at: number, daysAhead = 0): number {
  const date = new Date(at);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + daysAhead).getTime();
}

export function agenda(items: readonly CalendarItem[], from: number, to: number): Occurrence[] {
  return items
    .flatMap((item) => occurrences(item, from, to))
    .sort((left, right) => left.start - right.start);
}

export function monthGrid(monthStart: number, firstDay: number): number[] {
  const first = new Date(monthStart);
  const year = first.getFullYear();
  const month = first.getMonth();
  const lead = (first.getDay() - firstDay + 7) % 7;
  const length = new Date(year, month + 1, 0).getDate();
  const weeks = Math.ceil((lead + length) / 7);
  return Array.from({ length: weeks * 7 }, (_, index) =>
    new Date(year, month, 1 - lead + index).getTime()
  );
}

export function occursOn(occurrence: Occurrence, day: number): boolean {
  const date = new Date(day);
  const next = new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime();
  return occurrence.start < next && Math.max(occurrence.end, occurrence.start + 1) > day;
}

export interface CalendarDraft {
  title: string;
  description: string;
  location: string;
  start: number;
  end: number;
  allDay: boolean;
  frequency: Frequency | null;
  until: string | null;
}

export function buildEvent(
  draft: CalendarDraft,
  base: Record<string, unknown> | null,
  uid: string,
  now: number,
  timeZone: string
): Record<string, unknown> {
  return buildCalendarEvent(
    {
      title: draft.title,
      description: draft.description,
      location: draft.location,
      start: epochToLocal(draft.start),
      duration_ms: draft.end - draft.start,
      all_day: draft.allDay,
      frequency: draft.frequency,
      until: draft.until,
    },
    base,
    uid,
    now,
    timeZone
  );
}
