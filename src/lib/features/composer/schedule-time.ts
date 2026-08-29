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
