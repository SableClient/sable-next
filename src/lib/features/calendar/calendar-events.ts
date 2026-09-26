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
const DAY = 86_400_000;
const MAX_STEPS = 100_000;
const WEEKDAYS = ['su', 'mo', 'tu', 'we', 'th', 'fr', 'sa'];
const UNMODELLED_PARTS = [
  'byMonth',
  'byYearDay',
  'byWeekNo',
  'byHour',
  'byMinute',
  'bySecond',
  'bySetPosition',
];

interface NDay {
  day: number;
  nth: number | null;
}

interface Recurrence {
  frequency: Frequency;
  interval: number;
  count: number | null;
  until: string | null;
  byDay: NDay[];
  byMonthDay: number[];
  firstDayOfWeek: number;
  modelled: boolean;
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
  recurrenceId: string | null;
  start: number;
  end: number;
}

interface RsvpTally {
  accepted: number;
  tentative: number;
  declined: number;
  mine: RsvpStatus | null;
  people: Record<RsvpStatus, string[]>;
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

function isRealDateTime(local: string): boolean {
  const match = LOCAL_DATE_TIME.exec(local);
  if (!match) return false;
  const [year, month, day, hour, minute, second] = groups(match);
  const at = new Date(Date.UTC(year, month - 1, day, hour, minute, second));
  return (
    at.getUTCFullYear() === year &&
    at.getUTCMonth() === month - 1 &&
    at.getUTCDate() === day &&
    at.getUTCHours() === hour &&
    at.getUTCMinutes() === minute
  );
}

function readNDays(value: unknown): NDay[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const days: NDay[] = [];
  for (const entry of value) {
    const day = isRecord(entry) ? WEEKDAYS.indexOf(text(entry.day)) : -1;
    if (!isRecord(entry) || day === -1) return null;
    const nth = entry.nthOfPeriod;
    days.push({ day, nth: typeof nth === 'number' && nth !== 0 ? nth : null });
  }
  return days;
}

function readRecurrence(value: unknown): Recurrence | null {
  const rule: unknown = Array.isArray(value) ? value[0] : undefined;
  if (!isRecord(rule) || !FREQUENCIES.includes(text(rule.frequency))) return null;
  const frequency = text(rule.frequency) as Frequency;
  const byDay = readNDays(rule.byDay);
  const byMonthDay = Array.isArray(rule.byMonthDay)
    ? rule.byMonthDay.filter((day): day is number => Number.isInteger(day) && day !== 0)
    : [];
  const firstDayOfWeek = WEEKDAYS.indexOf(text(rule.firstDayOfWeek));
  const modelled =
    byDay !== null &&
    (rule.rscale === undefined || text(rule.rscale).toLowerCase() === 'gregorian') &&
    UNMODELLED_PARTS.every((part) => !Array.isArray(rule[part]) || rule[part].length === 0) &&
    (byDay.length === 0 ||
      frequency === 'monthly' ||
      (frequency === 'weekly' && byDay.every((day) => day.nth === null))) &&
    (byMonthDay.length === 0 || frequency === 'monthly');
  return {
    frequency,
    interval: typeof rule.interval === 'number' && rule.interval > 0 ? rule.interval : 1,
    count: typeof rule.count === 'number' ? rule.count : null,
    until: typeof rule.until === 'string' ? rule.until : null,
    byDay: byDay ?? [],
    byMonthDay,
    firstDayOfWeek: firstDayOfWeek === -1 ? 1 : firstDayOfWeek,
    modelled,
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
  if (uid === '' || !isRealDateTime(start)) return null;
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

function monthDays(year: number, month: number, rule: Recurrence): number[] {
  const length = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const days = new Set<number>();
  for (const day of rule.byMonthDay) {
    const date = day > 0 ? day : length + day + 1;
    if (date >= 1 && date <= length) days.add(date);
  }
  for (const { day, nth } of rule.byDay) {
    const first = ((day - new Date(Date.UTC(year, month, 1)).getUTCDay() + 7) % 7) + 1;
    const matches: number[] = [];
    for (let date = first; date <= length; date += 7) matches.push(date);
    const picked = nth === null ? matches : [matches.at(nth > 0 ? nth - 1 : nth)];
    for (const date of picked) if (date !== undefined) days.add(date);
  }
  return [...days].sort((left, right) => left - right);
}

function* wallTimes(start: string, rule: Recurrence | null): Generator<string> {
  yield start;
  const match = LOCAL_DATE_TIME.exec(start);
  if (!rule?.modelled || !match) return;
  const [year, month, day, hour, minute, second] = groups(match);
  const first = Date.UTC(year, month - 1, day, hour, minute, second);
  const iso = (at: number) => new Date(at).toISOString().slice(0, 19);
  for (let period = 1; period < MAX_STEPS; period += 1) {
    const amount = rule.interval * period;
    if (rule.frequency === 'weekly' && rule.byDay.length > 0) {
      const weekStart = first - ((new Date(first).getUTCDay() - rule.firstDayOfWeek + 7) % 7) * DAY;
      const offsets = rule.byDay
        .map(({ day: weekday }) => (weekday - rule.firstDayOfWeek + 7) % 7)
        .sort((left, right) => left - right);
      for (const offset of new Set(offsets)) {
        const at = weekStart + ((period - 1) * rule.interval * 7 + offset) * DAY;
        if (at > first) yield iso(at);
      }
    } else if (
      rule.frequency === 'monthly' &&
      (rule.byDay.length > 0 || rule.byMonthDay.length > 0)
    ) {
      const index = month - 1 + (period - 1) * rule.interval;
      const inYear = year + Math.floor(index / 12);
      for (const date of monthDays(inYear, index % 12, rule)) {
        const at = Date.UTC(inYear, index % 12, date, hour, minute, second);
        if (at > first) yield iso(at);
      }
    } else {
      const at = new Date(first);
      if (rule.frequency === 'daily') at.setUTCDate(at.getUTCDate() + amount);
      if (rule.frequency === 'weekly') at.setUTCDate(at.getUTCDate() + amount * 7);
      if (rule.frequency === 'monthly') at.setUTCMonth(at.getUTCMonth() + amount);
      if (rule.frequency === 'yearly') at.setUTCFullYear(at.getUTCFullYear() + amount);
      const monthly = rule.frequency === 'monthly' || rule.frequency === 'yearly';
      if (!monthly || at.getUTCDate() === day) yield iso(at.getTime());
    }
  }
}

function occurrences(item: CalendarItem, from: number, to: number): Occurrence[] {
  const found: Occurrence[] = [];
  const until = item.recurrence?.until
    ? localToEpoch(item.recurrence.until.slice(0, 19), item.timeZone)
    : null;
  const limit = item.recurrence ? (item.recurrence.count ?? Infinity) : 1;
  let produced = 0;
  for (const local of wallTimes(item.start, item.recurrence)) {
    if (produced >= limit) break;
    produced += 1;
    const start = localToEpoch(local, item.timeZone);
    if (start === null || start >= to || (until !== null && start > until)) break;
    const end = start + item.durationMs;
    if (end >= from)
      found.push({ item, recurrenceId: item.recurrence === null ? null : local, start, end });
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
  recurrenceId: string | null,
  userId: string | null
): RsvpTally {
  const latest = new Map<string, CalendarRsvpView>();
  for (const rsvp of rsvps) {
    if (rsvp.uid !== uid || !RSVP_STATUSES.includes(rsvp.status)) continue;
    if (rsvp.recurrence_id !== null && rsvp.recurrence_id !== recurrenceId) continue;
    const previous = latest.get(rsvp.sender);
    if (!previous || previous.timestamp <= rsvp.timestamp) latest.set(rsvp.sender, rsvp);
  }
  const tally: RsvpTally = {
    accepted: 0,
    tentative: 0,
    declined: 0,
    mine: null,
    people: { accepted: [], tentative: [], declined: [] },
  };
  for (const [sender, rsvp] of latest) {
    const status = rsvp.status as RsvpStatus;
    tally[status] += 1;
    tally.people[status].push(sender);
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
  until: string | null;
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
    start: draft.allDay
      ? `${epochToLocal(draft.start).slice(0, 10)}T00:00:00`
      : epochToLocal(draft.start),
    timeZone: draft.allDay ? null : timeZone,
    duration: draft.allDay
      ? `P${String(Math.max(1, Math.round((draft.end - draft.start) / DAY)))}D`
      : formatDuration(Math.max(0, draft.end - draft.start)),
    showWithoutTime: draft.allDay,
    ...(draft.description ? { description: draft.description } : {}),
    ...(draft.location
      ? { locations: { main: { '@type': 'Location', name: draft.location } } }
      : {}),
    ...(draft.frequency ? { recurrenceRules: [recurrenceRule(draft, base)] } : {}),
  };
}

function recurrenceRule(
  draft: CalendarDraft,
  base: Record<string, unknown> | null
): Record<string, unknown> {
  const previous: unknown = Array.isArray(base?.recurrenceRules)
    ? base.recurrenceRules[0]
    : undefined;
  const {
    until: _until,
    count,
    ...kept
  } = isRecord(previous) && previous.frequency === draft.frequency ? previous : {};
  return {
    ...kept,
    '@type': 'RecurrenceRule',
    frequency: draft.frequency,
    ...(draft.until ? { until: `${draft.until}T23:59:59` } : count === undefined ? {} : { count }),
  };
}
