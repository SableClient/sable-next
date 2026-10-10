// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';

import type { RoomSummary } from '#src/generated/protocol';

const rooms = vi.hoisted(() => [] as RoomSummary[]);
vi.mock('#lib/rooms/room-list.svelte.js', () => ({
  useRoomList: () => ({ rooms }),
  roomLabel: (room: RoomSummary) => room.name ?? room.room_id,
}));
vi.mock('#lib/rooms/permalink.js', () => ({
  roomSectionPath: (_rooms: unknown, roomId: string, eventId: string) =>
    `/rooms/${roomId}?event=${eventId}`,
}));

import ForwardedLine from './ForwardedLine.svelte';

afterEach(() => {
  rooms.length = 0;
});

test('a forward from a joined room links to the original', () => {
  rooms.push({ room_id: '!origin:example.org', name: 'Origin' } as RoomSummary);
  render(ForwardedLine, {
    forwarded: { timestamp: null, room_id: '!origin:example.org', event_id: '$event' },
    roomId: '!here:example.org',
  });

  expect(screen.getByRole('link', { name: 'Forwarded from Origin' })).toHaveAttribute(
    'href',
    '/rooms/!origin:example.org?event=$event'
  );
});

test('a forward from earlier in the room jumps in place', async () => {
  const user = userEvent.setup();
  const onJumpToEvent = vi.fn();
  render(ForwardedLine, {
    forwarded: { timestamp: null, room_id: '!here:example.org', event_id: '$event' },
    roomId: '!here:example.org',
    onJumpToEvent,
  });

  await user.click(screen.getByRole('button', { name: 'Forwarded from earlier' }));
  expect(onJumpToEvent).toHaveBeenCalledWith('$event');
});

test('a private forward names no origin', () => {
  const { container } = render(ForwardedLine, {
    forwarded: { timestamp: null, room_id: null, event_id: null },
    roomId: '!here:example.org',
  });

  expect(screen.queryByRole('link')).not.toBeInTheDocument();
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
  expect(container.textContent.trim()).toMatch(/^Forwarded$/);
});
