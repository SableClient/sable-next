import { expect, test } from 'vitest';

import { presetOffsets, scheduleAt, tomorrowMorning } from './schedule-time.js';

const NOON = new Date('2026-08-30T12:00:00').getTime();

test('an incomplete choice is not schedulable', () => {
  expect(scheduleAt('', '09:00', NOON)).toBeNull();
  expect(scheduleAt('2026-09-01', '', NOON)).toBeNull();
});

test('a time already past is refused rather than fired immediately', () => {
  expect(scheduleAt('2026-08-30', '11:00', NOON)).toBeNull();
  expect(scheduleAt('2026-08-30', '12:00', NOON)).toBeNull();
});

test('a future local time resolves to its own timestamp', () => {
  expect(scheduleAt('2026-08-30', '13:30', NOON)).toBe(new Date('2026-08-30T13:30:00').getTime());
});

test('nonsense dates do not become NaN timestamps', () => {
  expect(scheduleAt('not-a-date', '13:30', NOON)).toBeNull();
});

test('tomorrow morning lands on 9am the next day, whatever the hour now', () => {
  const at = new Date(tomorrowMorning(NOON));

  expect(at.getDate()).toBe(31);
  expect(at.getHours()).toBe(9);
  expect(at.getMinutes()).toBe(0);
});

test('every preset is in the future', () => {
  for (const preset of presetOffsets) expect(preset.at(NOON)).toBeGreaterThan(NOON);
});
