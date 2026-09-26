// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';

import { preferences } from '#lib/settings/preferences.svelte.js';

import type { CalendarDraft, CalendarItem } from './calendar-events.js';
import CalendarEventDialog from './CalendarEventDialog.svelte';

afterEach(() => {
  preferences.dateFormat = 'auto';
  preferences.hour24Clock = false;
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
  render(CalendarEventDialog, { open: true, item: value, onOpenChange: vi.fn(), onSave });
  await screen.findByRole('dialog');
  return onSave;
}

function fields(): string[] {
  return [...document.querySelectorAll('[data-date-field-label]')].map(
    (label) => label.textContent
  );
}

async function save(): Promise<void> {
  await userEvent.click(screen.getByRole('button', { name: 'Save' }));
}

test('shows Never for an event that does not repeat, and no until field', async () => {
  await open(null);
  expect(screen.getByLabelText('Repeats')).toHaveTextContent('Never');
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

  await save();
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

  await save();
  await vi.waitFor(() => {
    expect(onSave).toHaveBeenCalledOnce();
  });
  expect(onSave.mock.calls[0]?.[0]).toMatchObject({
    allDay: true,
    start: new Date(2026, 9, 1).getTime(),
    end: new Date(2026, 9, 3).getTime(),
  });
});
