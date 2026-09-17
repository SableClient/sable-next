import i18next from 'i18next';

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

const HEX = '[0-9a-fA-F]';
const COLOR_VALUE = `#?(?:${HEX}{6}|${HEX}{3})(?![0-9a-fA-F])`;
const COLOR_FUNCTION = new RegExp(
  `^((?:(?:fg|bg)\\.color=${COLOR_VALUE}[ \\t]+)+)([\\s\\S]+)$`,
  'u'
);
const COLOR_TOKEN = new RegExp(`^(fg|bg)\\.color=(${COLOR_VALUE})$`, 'u');
const UNIXTIME = /^\$\[unixtime[ \t]+(\d+)\]/u;

export interface MfmColorArgs {
  fg?: string;
  bg?: string;
}

export interface ZonedInstant {
  instant: number;
  datetime: string;
  offsetLabel: string;
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
}

export function isOpaqueMatrixColor(value: string): boolean {
  return /^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(value);
}

function locale(): string {
  return i18next.resolvedLanguage ?? i18next.language;
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

export function matrixColorToMfmHex(value: string): string | undefined {
  return normalizeMfmHex(value)?.slice(1);
}

function mfmCloseIndex(src: string): number {
  let depth = 0;
  for (let index = 1; index < src.length; index += 1) {
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
): { raw: string; args: MfmColorArgs; text: string } | null {
  if (!src.startsWith('$[fg.color=') && !src.startsWith('$[bg.color=')) return null;
  const close = mfmCloseIndex(src);
  if (close < 0) return null;

  const inner = src.slice(2, close);
  const match = COLOR_FUNCTION.exec(inner);
  if (!match?.[1] || !match[2]) return null;

  const args = parseMfmColorArgs(match[1].trimEnd());
  const text = match[2].trim();
  if (!args || text === '') return null;
  return { raw: src.slice(0, close + 1), args, text };
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

export function parseMfmUnixtime(src: string): { raw: string; seconds: string } | null {
  const match = UNIXTIME.exec(src);
  if (!match?.[0] || !match[1] || unixtimeDatetime(match[1]) === null) return null;
  return { raw: match[0], seconds: match[1] };
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

function daysInMonth(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

function readInt(value: string, length: number): number | null {
  if (value.length !== length || !/^\d+$/.test(value)) return null;
  return Number(value);
}

export function canonicalDatetime(value: string): string | null {
  if (value.length < 17 || value[10] !== 'T' || value[4] !== '-' || value[7] !== '-') return null;
  const year = readInt(value.slice(0, 4), 4);
  const month = readInt(value.slice(5, 7), 2);
  const day = readInt(value.slice(8, 10), 2);
  if (
    year === null ||
    month === null ||
    day === null ||
    year < 1 ||
    year > 9999 ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > daysInMonth(year, month)
  ) {
    return null;
  }

  const rest = value.slice(11);
  const offsetAt = offsetIndex(rest);
  if (offsetAt === null) return null;
  const clockMatch = /^(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/u.exec(rest.slice(0, offsetAt));
  if (!clockMatch?.[1] || !clockMatch[2]) return null;
  const hour = Number(clockMatch[1]);
  const minute = Number(clockMatch[2]);
  const second = Number(clockMatch.at(3) ?? 0);
  if (hour > 23 || minute > 59 || second > 59) return null;

  const canonicalOffset = canonicalOffsetOf(rest.slice(offsetAt));
  if (canonicalOffset === null) return null;
  return `${String(year).padStart(4, '0')}-${pad(month)}-${pad(day)}T${pad(hour)}:${pad(minute)}:${pad(second)}${canonicalOffset}`;
}

function offsetIndex(rest: string): number | null {
  if (rest.endsWith('Z') || rest.endsWith('z')) return rest.length - 1;
  const colon = /[+-]\d{2}:\d{2}$/u.exec(rest);
  if (colon) return rest.length - colon[0].length;
  const compact = /[+-]\d{4}$/u.exec(rest);
  return compact ? rest.length - compact[0].length : null;
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

  const zulu = datetime.endsWith('Z');
  return {
    instant,
    datetime,
    offsetLabel: zulu ? 'UTC' : `UTC${datetime.slice(-6).replace('-', '−')}`,
    year: Number(datetime.slice(0, 4)),
    month: Number(datetime.slice(5, 7)),
    day: Number(datetime.slice(8, 10)),
    hour: Number(datetime.slice(11, 13)),
    minute: Number(datetime.slice(14, 16)),
  };
}

export function utcFallbackLabel(datetime: string): string {
  const zoned = parseZonedDatetime(datetime);
  if (!zoned) return datetime;
  const month = MONTHS[zoned.month - 1] ?? '';
  const offset = zoned.offsetLabel.replace('−', '-');
  return `${String(zoned.day)} ${month} ${String(zoned.year)}, ${pad(zoned.hour)}:${pad(zoned.minute)} (${offset})`;
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

export function formatRelativeTimestamp(instant: number, now = Date.now()): string {
  const delta = instant - now;
  const abs = Math.abs(delta);
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['year', 31_557_600_000],
    ['month', 2_629_800_000],
    ['day', 86_400_000],
    ['hour', 3_600_000],
    ['minute', 60_000],
  ];
  const format = new Intl.RelativeTimeFormat(locale(), { numeric: 'auto', style: 'short' });
  for (const [unit, size] of units) {
    if (abs >= size) return format.format(Math.round(delta / size), unit);
  }
  return format.format(Math.round(delta / 1000), 'second');
}

export function formatSenderWall(zoned: ZonedInstant, hour24: boolean): string {
  const utc = new Date(0);
  utc.setUTCFullYear(zoned.year, zoned.month - 1, zoned.day);
  utc.setUTCHours(zoned.hour, zoned.minute, 0, 0);
  const formatted = new Intl.DateTimeFormat(locale(), {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    ...(hour24 ? { hourCycle: 'h23' } : { hourCycle: 'h12' }),
  }).format(utc);
  return `${formatted} (${zoned.offsetLabel})`;
}
