import { expect, test, vi } from 'vitest';
import { preferences, setPreference } from '#lib/settings/preferences.svelte.js';
import { formatDate, formatMessageTimestamp, formatTime } from './date-time.js';

test('formatTime follows the 24-hour clock preference', () => {
  const afternoon = new Date(2026, 0, 1, 13, 5).getTime();
  const midnight = new Date(2026, 0, 1, 0, 5).getTime();
  const previous = preferences.hour24Clock;

  setPreference('hour24Clock', true);
  expect(formatTime(afternoon)).toBe('13:05');
  expect(formatTime(midnight)).toBe('00:05');

  setPreference('hour24Clock', false);
  expect(formatTime(afternoon)).toBe(
    new Date(afternoon).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  );

  setPreference('hour24Clock', previous);
});

test('formatDate uses translated day names', () => {
  const now = new Date(2026, 8, 1, 14, 0);
  vi.useFakeTimers();
  vi.setSystemTime(now);

  expect(formatDate(now.getTime())).toBe('Today');
  const yesterday = new Date(2026, 7, 31, 10, 0);
  expect(formatDate(yesterday.getTime())).toBe('Yesterday');

  vi.useRealTimers();
});

test('formatMessageTimestamp shows time only for today', () => {
  const now = new Date(2026, 8, 1, 14, 30);
  vi.useFakeTimers();
  vi.setSystemTime(now);
  setPreference('hour24Clock', true);

  expect(formatMessageTimestamp(now.getTime())).toBe('14:30');

  vi.useRealTimers();
});

test('formatMessageTimestamp shows yesterday with time', () => {
  const now = new Date(2026, 8, 1, 14, 30);
  vi.useFakeTimers();
  vi.setSystemTime(now);
  setPreference('hour24Clock', true);

  const yesterday = new Date(2026, 7, 31, 9, 15);
  expect(formatMessageTimestamp(yesterday.getTime())).toBe('Yesterday 09:15');

  vi.useRealTimers();
});

test('formatMessageTimestamp shows month and day for older messages in the same year', () => {
  const now = new Date(2026, 8, 1, 14, 30);
  vi.useFakeTimers();
  vi.setSystemTime(now);
  setPreference('hour24Clock', true);

  const older = new Date(2026, 7, 24, 9, 15);
  expect(formatMessageTimestamp(older.getTime())).toBe('August 24 09:15');

  vi.useRealTimers();
});

test('formatMessageTimestamp includes the year for messages from another year', () => {
  const now = new Date(2026, 8, 1, 14, 30);
  vi.useFakeTimers();
  vi.setSystemTime(now);
  setPreference('hour24Clock', true);

  const lastYear = new Date(2025, 7, 24, 9, 15);
  expect(formatMessageTimestamp(lastYear.getTime())).toBe('August 24, 2025 09:15');

  vi.useRealTimers();
});
