// @vitest-environment happy-dom

import { screen, within } from '@testing-library/svelte';
import { renderWithTooltips } from '#lib/test-support/render-with-tooltips.js';
import { userEvent } from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';

import type { CalendarView } from '#src/generated/protocol';

import { core as baseCore } from '#lib/core/__mocks__/context.js';

import CalendarPage from './CalendarPage.svelte';

vi.mock('#lib/core/context.js');

vi.mock('#lib/rooms/room-list.svelte.js', () => ({
  useRoomList: () => ({ rooms: [] }),
  findRoomByPathId: () => undefined,
}));

vi.mock('#lib/features/room/room-navigation.js', () => ({
  backToRoomList: vi.fn(),
  trackRoomEntry: vi.fn(),
}));

function local(at: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${String(at.getFullYear())}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T20:00:00`;
}

const soon = new Date(Date.now() + 2 * 86_400_000);

let listener: ((event: { type: string; room_id?: string }) => void) | null = null;

const core = Object.assign(baseCore, {
  subscribeEvents: vi.fn((onEvent: (event: { type: string; room_id?: string }) => void) => {
    listener = onEvent;
    return () => {
      listener = null;
    };
  }),
  calendarEntries: vi.fn((): Promise<CalendarView> =>
    Promise.resolve({
      entries: [
        {
          event_id: '$raid',
          sender: '@ana:x',
          timestamp: 1,
          event: { uid: 'raid', title: 'Raid', start: local(soon), duration: 'PT2H' },
        },
      ],
      rsvps: [
        {
          sender: '@alice:x',
          calendar_event_id: '$raid',
          uid: 'raid',
          recurrence_id: null,
          status: 'accepted',
          timestamp: 1,
        },
        {
          sender: '@carol:x',
          calendar_event_id: '$raid',
          uid: 'raid',
          recurrence_id: null,
          status: 'accepted',
          timestamp: 2,
        },
        {
          sender: '@bob:x',
          calendar_event_id: '$raid',
          uid: 'raid',
          recurrence_id: null,
          status: 'tentative',
          timestamp: 3,
        },
      ],
    })
  ),
  sendRawEvent: vi.fn(() => Promise.resolve()),
  roomMembers: vi.fn(() =>
    Promise.resolve([
      { user_id: '@alice:x', display_name: 'Alice' },
      { user_id: '@carol:x', display_name: 'Carol' },
    ])
  ),
});

test('offers room settings and members from the calendar header', async () => {
  const user = userEvent.setup();
  renderWithTooltips(CalendarPage, { roomId: '!cal:x' });

  await user.click(screen.getByRole('button', { name: 'More options' }));
  expect(screen.getByRole('menuitem', { name: 'Settings' })).toBeInTheDocument();
  expect(screen.getByRole('menuitem', { name: 'Members' })).toBeInTheDocument();
});

test('lists who answered each event, by name', async () => {
  renderWithTooltips(CalendarPage, { roomId: '!cal:x' });

  await vi.waitFor(() => {
    expect(screen.getAllByRole('definition').map((answer) => answer.textContent)).toEqual([
      'Alice and Carol',
      '@bob:x',
    ]);
  });
  expect(screen.getAllByRole('term').map((term) => term.textContent)).toEqual(['Going', 'Maybe']);
  expect(core.roomMembers).toHaveBeenCalledWith('!cal:x');
});

test('reloads when the core reports a change in this calendar, and only this one', async () => {
  renderWithTooltips(CalendarPage, { roomId: '!cal:x' });
  expect(await screen.findByRole('heading', { name: 'Raid' })).toBeInTheDocument();
  core.calendarEntries.mockClear();

  listener?.({ type: 'calendar_changed', room_id: '!other:x' });
  listener?.({ type: 'typing', room_id: '!cal:x' });
  expect(core.calendarEntries).not.toHaveBeenCalled();

  listener?.({ type: 'calendar_changed', room_id: '!cal:x' });
  expect(core.calendarEntries).toHaveBeenCalledWith('!cal:x');
});

test('answers and counts each occurrence of a recurring event on its own', async () => {
  const next = new Date(soon.getTime() + 7 * 86_400_000);
  core.calendarEntries.mockImplementation(() =>
    Promise.resolve({
      entries: [
        {
          event_id: '$weekly',
          sender: '@ana:x',
          timestamp: 1,
          event: {
            uid: 'weekly',
            title: 'Weekly',
            start: local(soon),
            duration: 'PT1H',
            recurrenceRules: [{ '@type': 'RecurrenceRule', frequency: 'weekly', count: 2 }],
          },
        },
      ],
      rsvps: [
        {
          sender: '@bob:x',
          calendar_event_id: '$weekly',
          uid: 'weekly',
          recurrence_id: local(next),
          status: 'tentative',
          timestamp: 1,
        },
      ],
    })
  );
  const user = userEvent.setup();
  renderWithTooltips(CalendarPage, { roomId: '!cal:x' });
  await vi.waitFor(() => {
    expect(screen.getAllByRole('heading', { name: 'Weekly' })).toHaveLength(2);
  });
  const [first, second] = screen
    .getAllByRole('heading', { name: 'Weekly' })
    .map((heading) => within(heading.closest('li') ?? document.body));

  await vi.waitFor(() => {
    expect(second.getByRole('definition')).toHaveTextContent('@bob:x');
  });
  expect(first.queryByRole('definition')).not.toBeInTheDocument();

  await user.click(first.getByRole('button', { name: /^Going/ }));
  expect(core.sendRawEvent).toHaveBeenCalledWith('!cal:x', 'moe.sable.calendar.rsvp', {
    uid: 'weekly',
    recurrenceId: local(soon),
    status: 'accepted',
    'm.relates_to': { rel_type: 'm.reference', event_id: '$weekly' },
  });
});

test("the month view lists the selected day's events", async () => {
  core.calendarEntries.mockImplementation(() =>
    Promise.resolve({
      entries: [
        {
          event_id: '$raid',
          sender: '@ana:x',
          timestamp: 1,
          event: { uid: 'raid', title: 'Raid', start: local(soon), duration: 'PT2H' },
        },
      ],
      rsvps: [],
    })
  );
  const user = userEvent.setup();
  renderWithTooltips(CalendarPage, { roomId: '!cal:x' });
  await user.click(await screen.findByRole('button', { name: 'Month' }));
  const date = soon.toLocaleDateString(undefined, { dateStyle: 'full' });
  const cell = await screen.findByRole('gridcell', { name: `${date}, 1 event` });
  expect(cell).toHaveAttribute('aria-selected', 'false');
  expect(within(cell).getByText('Raid')).toBeTruthy();
  await user.click(cell);
  expect(await screen.findByRole('heading', { name: 'Raid', level: 3 })).toBeTruthy();
});

test('arrow keys move the selected day and Enter opens a new event on it', async () => {
  const user = userEvent.setup();
  renderWithTooltips(CalendarPage, { roomId: '!cal:x' });
  await user.click(await screen.findByRole('button', { name: 'Month' }));
  const date = soon.toLocaleDateString(undefined, { dateStyle: 'full' });
  const cell = await screen.findByRole('gridcell', { name: `${date}, 1 event` });
  await user.click(cell);
  cell.focus();
  await user.keyboard('{ArrowRight}');
  const next = new Date(soon.getFullYear(), soon.getMonth(), soon.getDate() + 1);
  const moved = await screen.findByRole('gridcell', {
    name: next.toLocaleDateString(undefined, { dateStyle: 'full' }),
  });
  expect(moved).toHaveAttribute('aria-selected', 'true');
  await user.keyboard('{Enter}');
  expect(await screen.findByRole('dialog')).toBeInTheDocument();
});
