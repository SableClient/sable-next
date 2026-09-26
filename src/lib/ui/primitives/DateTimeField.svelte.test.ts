// @vitest-environment happy-dom

import { flushSync, mount } from 'svelte';
import { afterEach, expect, test } from 'vitest';

import { preferences } from '#lib/settings/preferences.svelte.js';

import DateTimeField from './DateTimeField.svelte';

afterEach(() => {
  preferences.dateFormat = 'auto';
  preferences.hour24Clock = false;
  document.body.replaceChildren();
});

function segments(): string[] {
  return [...document.querySelectorAll('[data-segment]')]
    .map((segment) => segment.getAttribute('data-segment') ?? '')
    .filter((part) => part !== 'literal');
}

function render(): void {
  mount(DateTimeField, {
    target: document.body,
    props: { label: 'Starts', value: '2026-12-31T17:05' },
  });
  flushSync();
}

test('orders the date the way the date format setting says', () => {
  preferences.dateFormat = 'dmy';
  render();
  expect(segments().slice(0, 3)).toEqual(['day', 'month', 'year']);
});

test('orders month first for the month-day-year setting', () => {
  preferences.dateFormat = 'mdy';
  render();
  expect(segments().slice(0, 3)).toEqual(['month', 'day', 'year']);
});

test('orders year first for the year-month-day setting', () => {
  preferences.dateFormat = 'ymd';
  render();
  expect(segments().slice(0, 3)).toEqual(['year', 'month', 'day']);
});

test('drops AM/PM when the 24-hour clock is on, whatever the date order', () => {
  preferences.dateFormat = 'mdy';
  preferences.hour24Clock = true;
  render();
  expect(segments()).not.toContain('dayPeriod');
  expect(document.querySelector('[data-segment="hour"]')?.textContent).toBe('17');
});

test('keeps the app locale clock when the date order borrows another locale', () => {
  preferences.dateFormat = 'dmy';
  render();
  expect(segments()).toContain('dayPeriod');
});

test('writes a typed segment back as a local ISO date-time', () => {
  preferences.dateFormat = 'dmy';
  preferences.hour24Clock = true;
  const props = $state({ label: 'Starts', value: '2026-12-31T17:05' });
  mount(DateTimeField, { target: document.body, props });
  flushSync();

  const hour = document.querySelector<HTMLElement>('[data-segment="hour"]');
  hour?.focus();
  for (const key of ['0', '9']) {
    hour?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
  }
  flushSync();

  expect(props.value).toBe('2026-12-31T09:05:00');
});
