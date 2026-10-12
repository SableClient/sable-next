import { parseZonedDatetime, unixSecondsOf } from '#lib/model/model.js';
import { currentLocale } from '#lib/i18n.js';

export type { MfmColorArgs, ZonedInstant } from '#src/generated/protocol';
export {
  canonicalDatetime,
  isOpaqueMatrixColor,
  normalizeMfmHex,
  parseMfmColor,
  parseMfmUnixtime,
  parseZonedDatetime,
} from '#lib/model/model.js';

export function utcFallbackLabel(datetime: string): string {
  const zoned = parseZonedDatetime(datetime);
  if (!zoned) return datetime;
  const offset = zoned.datetime.endsWith('Z') ? '' : zoned.datetime.slice(-6);
  const minutes =
    offset === ''
      ? 0
      : (offset.startsWith('-') ? -1 : 1) *
        (Number(offset.slice(1, 3)) * 60 + Number(offset.slice(4, 6)));
  const label = new Intl.DateTimeFormat(currentLocale(), {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(new Date(zoned.instant + minutes * 60_000));
  return `${label} (UTC${offset})`;
}

export function mfmUnixtime(datetime: string): string {
  const seconds = unixSecondsOf(datetime);
  return seconds === null ? utcFallbackLabel(datetime) : `$[unixtime ${seconds}]`;
}

export function formatUtcTime(instant: number, hour24: boolean): string {
  return formatZonedTime(instant, 'UTC', hour24);
}

function formatClockTime(instant: number, timeZone: string, hour24: boolean): string {
  return new Intl.DateTimeFormat(currentLocale(), {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    ...(hour24 ? { hourCycle: 'h23' } : { hourCycle: 'h12' }),
  }).format(new Date(instant));
}

function calendarDateParts(
  instant: number,
  timeZone?: string
): { year: string; month: string; day: string } {
  const parts = new Intl.DateTimeFormat('en-US-u-ca-gregory', {
    ...(timeZone ? { timeZone } : {}),
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
  }).formatToParts(new Date(instant));
  return {
    year: parts.find((part) => part.type === 'year')?.value ?? '',
    month: parts.find((part) => part.type === 'month')?.value ?? '',
    day: parts.find((part) => part.type === 'day')?.value ?? '',
  };
}

function formatZonedTime(instant: number, timeZone: string, hour24: boolean): string {
  const localDate = calendarDateParts(instant);
  const zonedDate = calendarDateParts(instant, timeZone);
  if (
    localDate.year === zonedDate.year &&
    localDate.month === zonedDate.month &&
    localDate.day === zonedDate.day
  ) {
    return formatClockTime(instant, timeZone, hour24);
  }

  return new Intl.DateTimeFormat(currentLocale(), {
    timeZone,
    day: 'numeric',
    month: 'long',
    ...(localDate.year !== zonedDate.year ? { year: 'numeric' } : {}),
    hour: '2-digit',
    minute: '2-digit',
    ...(hour24 ? { hourCycle: 'h23' } : { hourCycle: 'h12' }),
  }).format(new Date(instant));
}

export function formatTimeInZone(
  instant: number,
  timeZone: string,
  hour24: boolean
): string | null {
  try {
    return formatZonedTime(instant, timeZone, hour24);
  } catch {
    return null;
  }
}
