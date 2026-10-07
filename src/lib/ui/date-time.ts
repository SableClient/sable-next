import { currentLocale, t } from '#lib/i18n.js';
import { preferences } from '#lib/settings/preferences.svelte.js';

function isSameCalendarDay(a: Date, b: Date): boolean {
  return a.toDateString() === b.toDateString();
}

export function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString(currentLocale(), {
    hour: '2-digit',
    minute: '2-digit',
    ...(preferences.hour24Clock ? { hour12: false } : {}),
  });
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

function formatMessageDatePart(date: Date, includeYear: boolean): string {
  return date.toLocaleDateString(currentLocale(), {
    day: 'numeric',
    month: 'long',
    ...(includeYear ? { year: 'numeric' } : {}),
  });
}

export function formatMessageTimestamp(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const time = formatTime(timestamp);

  if (isSameCalendarDay(date, now)) return time;

  const yesterday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
  if (isSameCalendarDay(date, yesterday)) {
    return t('timeline.messageTimestamp', { date: t('common.yesterday'), time });
  }

  const sameYear = date.getFullYear() === now.getFullYear();
  const datePart = formatMessageDatePart(date, !sameYear);
  return t('timeline.messageTimestamp', { date: datePart, time });
}

export function formatFullTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleString(currentLocale(), {
    dateStyle: 'full',
    timeStyle: 'medium',
    ...(preferences.hour24Clock ? { hour12: false } : {}),
  });
}

export function formatDate(timestamp: number): string {
  const date = new Date(timestamp);
  const today = new Date();
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  if (isSameCalendarDay(date, today)) return t('common.today');
  if (isSameCalendarDay(date, yesterday)) return t('common.yesterday');

  const day = pad(date.getDate());
  const month = pad(date.getMonth() + 1);
  const year = String(date.getFullYear());
  switch (preferences.dateFormat) {
    case 'dmy':
      return `${day}/${month}/${year}`;
    case 'mdy':
      return `${month}/${day}/${year}`;
    case 'ymd':
      return `${year}-${month}-${day}`;
    default:
      return date.toLocaleDateString(currentLocale(), {
        day: 'numeric',
        month: 'long',
        year: 'numeric',
      });
  }
}
