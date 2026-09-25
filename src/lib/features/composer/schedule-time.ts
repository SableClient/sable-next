import { currentLocale } from '#lib/i18n.js';
import { formatTime } from '#lib/features/room/timeline-format.js';

export type SchedulePresetKey = 'In30Minutes' | 'In1Hour' | 'Tomorrow9am';

export interface SchedulePreset {
  key: SchedulePresetKey;
  at: (now: number) => number;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export function tomorrowMorning(now: number): number {
  const at = new Date(now);
  at.setDate(at.getDate() + 1);
  at.setHours(9, 0, 0, 0);
  return at.getTime();
}

export const presetOffsets: readonly SchedulePreset[] = [
  { key: 'In30Minutes', at: (now) => now + 30 * MINUTE },
  { key: 'In1Hour', at: (now) => now + HOUR },
  { key: 'Tomorrow9am', at: tomorrowMorning },
];

export function scheduleAt(date: string, time: string, now: number): number | null {
  if (date === '' || time === '') return null;

  const at = new Date(`${date}T${time}`);
  const ts = at.getTime();
  if (Number.isNaN(ts) || ts <= now) return null;
  return ts;
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

export function scheduleInputs(ts: number | null): { date: string; time: string } {
  if (ts === null) return { date: '', time: '' };

  const at = new Date(ts);
  return {
    date: `${String(at.getFullYear())}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`,
    time: `${pad(at.getHours())}:${pad(at.getMinutes())}`,
  };
}

export function scheduledTimeLabel(ts: number, now: number): string {
  const at = new Date(ts);
  const time = formatTime(ts);
  if (at.toDateString() === new Date(now).toDateString()) return time;

  const days = (ts - now) / (24 * HOUR);
  const sameYear = at.getFullYear() === new Date(now).getFullYear();
  const date = at.toLocaleDateString(
    currentLocale(),
    days > 0 && days < 6
      ? { weekday: 'short' }
      : { day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) }
  );
  return `${date} ${time}`;
}
