// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { expect, test, vi } from 'vitest';

import type { CalendarView, RoomSummary } from '#src/generated/protocol';

import { core as baseCore } from '#lib/core/__mocks__/context.js';

import SpaceEvents from './SpaceEvents.svelte';

vi.mock('#lib/core/context.js');
vi.mock('#lib/rooms/room-list.svelte.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useRoomList: () => ({ rooms: [room] }),
}));

function local(at: Date, hour: string): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${String(at.getFullYear())}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}T${hour}`;
}

const yesterday = new Date(Date.now() - 86_400_000);
const tomorrow = new Date(Date.now() + 86_400_000);
const today = new Date();

Object.assign(baseCore, {
  subscribeEvents: vi.fn(() => () => undefined),
  calendarEntries: vi.fn((): Promise<CalendarView> =>
    Promise.resolve({
      entries: [
        {
          event_id: '$now',
          sender: '@ana:x',
          timestamp: 1,
          event: {
            uid: 'now',
            title: 'Standup',
            start: local(today, '00:00:00'),
            duration: 'PT24H',
          },
        },
        {
          event_id: '$gone',
          sender: '@ana:x',
          timestamp: 3,
          event: {
            uid: 'gone',
            title: 'Holiday',
            start: local(yesterday, '00:00:00'),
            duration: 'P1D',
            showWithoutTime: true,
            timeZone: null,
          },
        },
        {
          event_id: '$later',
          sender: '@ana:x',
          timestamp: 2,
          event: {
            uid: 'later',
            title: 'Raid',
            start: local(tomorrow, '20:00:00'),
            duration: 'PT2H',
          },
        },
      ],
      rsvps: [],
    })
  ),
});

const room = { room_id: '!cal:x', name: 'Events' } as RoomSummary;

test('lists the events that fall on today and leaves later days out', async () => {
  render(SpaceEvents, { spaceId: '!space:x', rooms: [room] });
  expect(await screen.findByText('Standup')).toBeTruthy();
  expect(screen.queryByText('Raid')).toBeNull();
  expect(screen.queryByText('Holiday')).toBeNull();
});
