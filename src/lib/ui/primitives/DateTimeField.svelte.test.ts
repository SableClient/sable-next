// @vitest-environment happy-dom

import { render } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, test } from 'vitest';

import { preferences } from '#lib/settings/preferences.svelte.js';

import DateTimeField from './DateTimeField.svelte';

afterEach(() => {
  preferences.dateFormat = 'auto';
  preferences.hour24Clock = false;
});

function segments(): string[] {
  return [...document.querySelectorAll('[data-segment]')]
    .map((segment) => segment.getAttribute('data-segment') ?? '')
    .filter((part) => part !== 'literal');
}

function setup(): void {
  render(DateTimeField, { label: 'Starts', value: '2026-12-31T17:05' });
}

test('orders the date the way the date format setting says', () => {
  preferences.dateFormat = 'dmy';
  setup();
  expect(segments().slice(0, 3)).toEqual(['day', 'month', 'year']);
});

test('orders month first for the month-day-year setting', () => {
  preferences.dateFormat = 'mdy';
  setup();
  expect(segments().slice(0, 3)).toEqual(['month', 'day', 'year']);
});

test('orders year first for the year-month-day setting', () => {
  preferences.dateFormat = 'ymd';
  setup();
  expect(segments().slice(0, 3)).toEqual(['year', 'month', 'day']);
});

test('drops AM/PM when the 24-hour clock is on, whatever the date order', () => {
  preferences.dateFormat = 'mdy';
  preferences.hour24Clock = true;
  setup();
  expect(segments()).not.toContain('dayPeriod');
  expect(document.querySelector('[data-segment="hour"]')?.textContent).toBe('17');
});

test('keeps the app locale clock when the date order borrows another locale', () => {
  preferences.dateFormat = 'dmy';
  setup();
  expect(segments()).toContain('dayPeriod');
});

test('writes a typed segment back as a local ISO date-time', async () => {
  const user = userEvent.setup();
  preferences.dateFormat = 'dmy';
  preferences.hour24Clock = true;
  const props = $state({ label: 'Starts', value: '2026-12-31T17:05' });
  render(DateTimeField, { props });

  const hour = document.querySelector<HTMLElement>('[data-segment="hour"]');
  if (!hour) throw new Error('hour segment missing');
  await user.click(hour);
  await user.keyboard('09');

  expect(props.value).toBe('2026-12-31T09:05:00');
});
