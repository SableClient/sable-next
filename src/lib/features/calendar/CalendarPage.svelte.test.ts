// @vitest-environment happy-dom

import { flushSync, mount, tick } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

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

afterEach(() => {
  document.body.replaceChildren();
});

test('lists who answered each event, by name', async () => {
  mount(CalendarPage, { target: document.body, props: { roomId: '!cal:x' } });
  await vi.waitFor(() => {
    expect(document.querySelector('.calendar-event-people')).not.toBeNull();
  });
  await tick();
  flushSync();

  const rows = [...document.querySelectorAll('.calendar-event-people > div')].map((row) => [
    row.querySelector('dt')?.textContent,
    row.querySelector('dd')?.textContent,
  ]);
  expect(rows).toEqual([
    ['Going', 'Alice and Carol'],
    ['Maybe', '@bob:x'],
  ]);
  expect(core.roomMembers).toHaveBeenCalledWith('!cal:x');
});

test('reloads when the core reports a change in this calendar, and only this one', async () => {
  mount(CalendarPage, { target: document.body, props: { roomId: '!cal:x' } });
  await vi.waitFor(() => {
    expect(document.querySelector('.calendar-event')).not.toBeNull();
  });
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
  mount(CalendarPage, { target: document.body, props: { roomId: '!cal:x' } });
  await vi.waitFor(() => {
    expect(document.querySelectorAll('.calendar-event')).toHaveLength(2);
  });
  await tick();
  flushSync();

  const [first, second] = document.querySelectorAll('.calendar-event');
  expect(first.querySelector('.calendar-event-people')).toBeNull();
  expect(second.querySelector('.calendar-event-people dd')?.textContent).toBe('@bob:x');

  const going = [...first.querySelectorAll('button')].find((button) =>
    button.textContent.trim().startsWith('Going')
  );
  going?.click();
  expect(core.sendRawEvent).toHaveBeenCalledWith('!cal:x', 'moe.sable.calendar.rsvp', {
    uid: 'weekly',
    recurrenceId: local(soon),
    status: 'accepted',
    'm.relates_to': { rel_type: 'm.reference', event_id: '$weekly' },
  });
});
