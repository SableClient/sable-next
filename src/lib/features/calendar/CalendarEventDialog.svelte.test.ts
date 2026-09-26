// @vitest-environment happy-dom

import { flushSync, mount, tick } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

import { preferences } from '#lib/settings/preferences.svelte.js';

import type { CalendarDraft, CalendarItem } from './calendar-events.js';
import CalendarEventDialog from './CalendarEventDialog.svelte';

afterEach(() => {
  preferences.dateFormat = 'auto';
  preferences.hour24Clock = false;
  document.body.replaceChildren();
});

function item(overrides: Partial<CalendarItem>): CalendarItem {
  return {
    eventId: '$raid',
    sender: '@ana:x',
    uid: 'raid',
    title: 'Raid',
    description: '',
    location: '',
    allDay: false,
    start: '2026-10-01T20:00:00',
    timeZone: null,
    durationMs: 2 * 3_600_000,
    recurrence: null,
    raw: {},
    ...overrides,
  };
}

async function open(
  value: CalendarItem | null,
  onSave = vi.fn<(draft: CalendarDraft) => Promise<void>>(() => Promise.resolve())
) {
  mount(CalendarEventDialog, {
    target: document.body,
    props: { open: true, item: value, onOpenChange: vi.fn(), onSave },
  });
  await tick();
  flushSync();
  return onSave;
}

function fields(): string[] {
  return [...document.querySelectorAll('[data-date-field-label]')].map(
    (label) => label.textContent
  );
}

test('shows Never for an event that does not repeat, and no until field', async () => {
  await open(null);
  expect(document.querySelector('[data-select-trigger]')?.textContent).toContain('Never');
  expect(fields()).toEqual(['Starts', 'Ends']);
});

test('offers the until date of a repeating event and saves it', async () => {
  preferences.dateFormat = 'dmy';
  const onSave = await open(
    item({
      recurrence: {
        frequency: 'weekly',
        interval: 1,
        count: null,
        until: '2026-12-01T23:59:59',
        byDay: [],
        byMonthDay: [],
        firstDayOfWeek: 1,
        modelled: true,
      },
    })
  );
  expect(fields()).toEqual(['Starts', 'Ends', 'Until']);

  document.querySelector<HTMLFormElement>('form.calendar-form')?.requestSubmit();
  await vi.waitFor(() => {
    expect(onSave).toHaveBeenCalledOnce();
  });
  expect(onSave.mock.calls[0]?.[0]).toMatchObject({ frequency: 'weekly', until: '2026-12-01' });
});

test('edits an all-day event as dates, with an inclusive last day', async () => {
  const onSave = await open(
    item({ allDay: true, start: '2026-10-01T00:00:00', durationMs: 2 * 86_400_000 })
  );
  expect(document.querySelector('[data-segment="hour"]')).toBeNull();

  document.querySelector<HTMLFormElement>('form.calendar-form')?.requestSubmit();
  await vi.waitFor(() => {
    expect(onSave).toHaveBeenCalledOnce();
  });
  expect(onSave.mock.calls[0]?.[0]).toMatchObject({
    allDay: true,
    start: new Date(2026, 9, 1).getTime(),
    end: new Date(2026, 9, 3).getTime(),
  });
});
