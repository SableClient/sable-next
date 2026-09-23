import { currentLocale } from '#lib/i18n.js';

const MFM_SPAN_LIMIT = 2048;

const HEX = '[0-9a-fA-F]';
const COLOR_VALUE = `#?(?:${HEX}{6}|${HEX}{3})(?![0-9a-fA-F])`;
const COLOR_FUNCTION = new RegExp(
  `^((?:(?:fg|bg)\\.color=${COLOR_VALUE}[ \\t]+)+)([\\s\\S]+)$`,
  'u'
);
const COLOR_TOKEN = new RegExp(`^(fg|bg)\\.color=(${COLOR_VALUE})$`, 'u');
const UNIXTIME = /^\$\[unixtime[ \t]+(\d+)\]/u;
const ZONED_DATETIME =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(Z|[+-]\d{2}:?\d{2})$/iu;

export interface MfmColorArgs {
  fg?: string;
  bg?: string;
}

export interface ZonedInstant {
  instant: number;
  datetime: string;
}

export function isOpaqueMatrixColor(value: string): boolean {
  return /^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(value);
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

export function normalizeMfmHex(value: string): string | undefined {
  const digits = value.replace(/^#/, '').toLowerCase();
  if (!/^(?:[\da-f]{3}|[\da-f]{6})$/.test(digits)) return undefined;
  const expanded =
    digits.length === 3
      ? `${digits[0]}${digits[0]}${digits[1]}${digits[1]}${digits[2]}${digits[2]}`
      : digits;
  return `#${expanded}`;
}

function mfmCloseIndex(src: string): number {
  let depth = 0;
  const end = Math.min(src.length, MFM_SPAN_LIMIT);
  for (let index = 1; index < end; index += 1) {
    const character = src[index];
    if (character === '\\') {
      index += 1;
    } else if (character === '[') {
      depth += 1;
    } else if (character === ']' && --depth === 0) {
      return index;
    }
  }
  return -1;
}

export function parseMfmColor(
  src: string
): { raw: string; args: MfmColorArgs; text: string; offset: number } | null {
  if (!src.startsWith('$[fg.color=') && !src.startsWith('$[bg.color=')) return null;
  const close = mfmCloseIndex(src);
  if (close < 0) return null;

  const inner = src.slice(2, close);
  const match = COLOR_FUNCTION.exec(inner);
  if (!match?.[1] || !match[2]) return null;

  const args = parseMfmColorArgs(match[1].trimEnd());
  const text = match[2].trim();
  if (!args || text === '') return null;
  const offset = 2 + match[1].length + match[2].length - match[2].trimStart().length;
  return { raw: src.slice(0, close + 1), args, text, offset };
}

export function parseMfmColorArgs(argsPart: string): MfmColorArgs | null {
  const tokens = argsPart.trim().split(/[ \t]+/u);
  if (tokens.length === 0 || tokens[0] === '') return null;

  const result: MfmColorArgs = {};
  for (const token of tokens) {
    const match = COLOR_TOKEN.exec(token);
    if (!match?.[1] || !match[2]) return null;
    const normalized = normalizeMfmHex(match[2]);
    if (!normalized) return null;
    if (match[1] === 'fg') result.fg = normalized;
    else result.bg = normalized;
  }
  return result.fg === undefined && result.bg === undefined ? null : result;
}

export function parseMfmUnixtime(src: string): { raw: string; datetime: string } | null {
  const match = UNIXTIME.exec(src);
  if (!match?.[0] || !match[1]) return null;
  const datetime = unixtimeDatetime(match[1]);
  return datetime ? { raw: match[0], datetime } : null;
}

export function unixtimeDatetime(seconds: string): string | null {
  if (!/^\d+$/.test(seconds)) return null;
  const value = Number(seconds);
  if (!Number.isSafeInteger(value)) return null;
  const date = new Date(value * 1000);
  if (Number.isNaN(date.getTime()) || date.getUTCFullYear() < 1 || date.getUTCFullYear() > 9999) {
    return null;
  }
  return date.toISOString().replace(/\.\d{3}Z$/u, 'Z');
}

export function canonicalDatetime(value: string): string | null {
  const match = ZONED_DATETIME.exec(value);
  if (!match) return null;
  const [, yearText, monthText, dayText, hourText, minuteText, secondText = '00', offsetText] =
    match;
  const [year, month, day, hour, minute, second] = [
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText,
  ].map(Number);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, 0);
  if (
    year < 1 ||
    year > 9999 ||
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day ||
    date.getUTCHours() !== hour ||
    date.getUTCMinutes() !== minute ||
    date.getUTCSeconds() !== second
  )
    return null;
  const canonicalOffset = canonicalOffsetOf(offsetText);
  if (canonicalOffset === null) return null;
  return `${yearText}-${monthText}-${dayText}T${hourText}:${minuteText}:${pad(second)}${canonicalOffset}`;
}

function canonicalOffsetOf(offset: string): string | null {
  if (offset === 'Z' || offset === 'z') return 'Z';
  const match = /^([+-])(\d{2}):?(\d{2})$/u.exec(offset);
  if (!match?.[1] || !match[2] || !match[3]) return null;
  const hours = Number(match[2]);
  const minutes = Number(match[3]);
  if (hours > 23 || minutes > 59) return null;
  if (hours === 0 && minutes === 0) return 'Z';
  return `${match[1]}${pad(hours)}:${pad(minutes)}`;
}

export function parseZonedDatetime(value: string): ZonedInstant | null {
  const datetime = canonicalDatetime(value);
  if (!datetime) return null;
  const instant = Date.parse(datetime);
  if (Number.isNaN(instant)) return null;

  return {
    instant,
    datetime,
  };
}

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

export function unixSecondsOf(datetime: string): string | null {
  const zoned = parseZonedDatetime(datetime);
  if (!zoned) return null;
  const seconds = Math.floor(zoned.instant / 1000);
  if (!Number.isSafeInteger(seconds) || seconds < 0) return null;
  return String(seconds);
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
