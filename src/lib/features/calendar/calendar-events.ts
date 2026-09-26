import type { CalendarEntryView, CalendarRsvpView } from '#src/generated/protocol';

import { isRecord } from '#lib/guards.js';

export const CALENDAR_ROOM_TYPE = 'chat.commet.calendar';
export const RSVP_EVENT = 'moe.sable.calendar.rsvp';

export type RsvpStatus = 'accepted' | 'tentative' | 'declined';
export type Frequency = 'daily' | 'weekly' | 'monthly' | 'yearly';

const RSVP_STATUSES: readonly string[] = ['accepted', 'tentative', 'declined'];
const FREQUENCIES: readonly string[] = ['daily', 'weekly', 'monthly', 'yearly'];
const LOCAL_DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/;
const DURATION = /^P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/;
const MINUTE = 60_000;

interface Recurrence {
  frequency: Frequency;
  interval: number;
  count: number | null;
  until: string | null;
}

export interface CalendarItem {
  eventId: string;
  sender: string;
  uid: string;
  title: string;
  description: string;
  location: string;
  allDay: boolean;
  start: string;
  timeZone: string | null;
  durationMs: number;
  recurrence: Recurrence | null;
  raw: Record<string, unknown>;
}

export interface Occurrence {
  item: CalendarItem;
  start: number;
  end: number;
}

interface RsvpTally {
  accepted: number;
  tentative: number;
  declined: number;
  mine: RsvpStatus | null;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function groups(match: RegExpExecArray): [number, number, number, number, number, number] {
  const parts: (string | undefined)[] = match.slice(1);
  const at = (index: number): number => Number(parts[index] ?? 0);
  return [at(0), at(1), at(2), at(3), at(4), at(5)];
}

export function parseDuration(value: unknown): number {
  const match = typeof value === 'string' ? DURATION.exec(value) : null;
  if (!match) return 0;
  const [weeks, days, hours, minutes, seconds] = groups(match);
  return (((weeks * 7 + days) * 24 + hours) * 60 + minutes) * MINUTE + seconds * 1000;
}

export function formatDuration(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / MINUTE));
  if (minutes === 0) return 'PT0S';
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  const date = days ? `${String(days)}D` : '';
  const time =
    hours || rest ? `T${hours ? `${String(hours)}H` : ''}${rest ? `${String(rest)}M` : ''}` : '';
  return `P${date}${time}`;
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

function readRecurrence(value: unknown): Recurrence | null {
  const rule: unknown = Array.isArray(value) ? value[0] : undefined;
  if (!isRecord(rule) || !FREQUENCIES.includes(text(rule.frequency))) return null;
  return {
    frequency: text(rule.frequency) as Frequency,
    interval: typeof rule.interval === 'number' && rule.interval > 0 ? rule.interval : 1,
    count: typeof rule.count === 'number' ? rule.count : null,
    until: typeof rule.until === 'string' ? rule.until : null,
  };
}

function firstLocationName(value: unknown): string {
  if (!isRecord(value)) return '';
  const first = Object.values(value).find(isRecord);
  return first ? text(first.name) : '';
}

export function readEntry(entry: CalendarEntryView): CalendarItem | null {
  const event = entry.event;
  if (!isRecord(event)) return null;
  const uid = text(event.uid);
  const start = text(event.start);
  if (uid === '' || !LOCAL_DATE_TIME.test(start)) return null;
  return {
    eventId: entry.event_id,
    sender: entry.sender,
    uid,
    title: text(event.title),
    description: text(event.description),
    location: firstLocationName(event.locations),
    allDay: event.showWithoutTime === true,
    start,
    timeZone: typeof event.timeZone === 'string' ? event.timeZone : null,
    durationMs: parseDuration(event.duration),
    recurrence: readRecurrence(event.recurrenceRules),
    raw: event,
  };
}

function step(local: string, recurrence: Recurrence, times: number): string {
  const match = LOCAL_DATE_TIME.exec(local);
  if (!match) return local;
  const [year, month, day, hour, minute, second] = groups(match);
  const amount = recurrence.interval * times;
  const at = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  if (recurrence.frequency === 'daily') at.setUTCDate(at.getUTCDate() + amount);
  if (recurrence.frequency === 'weekly') at.setUTCDate(at.getUTCDate() + amount * 7);
  if (recurrence.frequency === 'monthly') at.setUTCMonth(at.getUTCMonth() + amount);
  if (recurrence.frequency === 'yearly') at.setUTCFullYear(at.getUTCFullYear() + amount);
  return at.toISOString().slice(0, 19);
}

function occurrences(item: CalendarItem, from: number, to: number): Occurrence[] {
  const found: Occurrence[] = [];
  const until = item.recurrence?.until
    ? localToEpoch(item.recurrence.until.slice(0, 19), item.timeZone)
    : null;
  const limit = item.recurrence ? (item.recurrence.count ?? Infinity) : 1;
  for (let index = 0; index < limit; index += 1) {
    const local = item.recurrence ? step(item.start, item.recurrence, index) : item.start;
    const start = localToEpoch(local, item.timeZone);
    if (start === null || start >= to || (until !== null && start > until)) break;
    const end = start + item.durationMs;
    if (end >= from) found.push({ item, start, end });
  }
  return found;
}

export function agenda(items: readonly CalendarItem[], from: number, to: number): Occurrence[] {
  return items
    .flatMap((item) => occurrences(item, from, to))
    .sort((left, right) => left.start - right.start);
}

export function tallyRsvps(
  rsvps: readonly CalendarRsvpView[],
  uid: string,
  userId: string | null
): RsvpTally {
  const latest = new Map<string, CalendarRsvpView>();
  for (const rsvp of rsvps) {
    if (rsvp.uid !== uid || !RSVP_STATUSES.includes(rsvp.status)) continue;
    const previous = latest.get(rsvp.sender);
    if (!previous || previous.timestamp <= rsvp.timestamp) latest.set(rsvp.sender, rsvp);
  }
  const tally: RsvpTally = { accepted: 0, tentative: 0, declined: 0, mine: null };
  for (const [sender, rsvp] of latest) {
    const status = rsvp.status as RsvpStatus;
    tally[status] += 1;
    if (sender === userId) tally.mine = status;
  }
  return tally;
}

export interface CalendarDraft {
  title: string;
  description: string;
  location: string;
  start: number;
  end: number;
  allDay: boolean;
  frequency: Frequency | null;
}

export function buildEvent(
  draft: CalendarDraft,
  base: Record<string, unknown> | null,
  uid: string,
  now: number,
  timeZone: string
): Record<string, unknown> {
  const {
    recurrenceRules: _rules,
    locations: _locations,
    description: _description,
    ...kept
  } = base ?? {};
  return {
    ...kept,
    '@type': 'Event',
    uid,
    updated: new Date(now).toISOString().replace(/\.\d+Z$/, 'Z'),
    title: draft.title,
    start: epochToLocal(draft.start),
    timeZone,
    duration: formatDuration(Math.max(0, draft.end - draft.start)),
    showWithoutTime: draft.allDay,
    ...(draft.description ? { description: draft.description } : {}),
    ...(draft.location
      ? { locations: { main: { '@type': 'Location', name: draft.location } } }
      : {}),
    ...(draft.frequency
      ? { recurrenceRules: [{ '@type': 'RecurrenceRule', frequency: draft.frequency }] }
      : {}),
  };
}
