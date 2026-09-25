// @vitest-environment happy-dom

import { mount, unmount } from 'svelte';
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
  document.body.replaceChildren();
  rooms.length = 0;
});

test('a forward from a joined room links to the original', async () => {
  rooms.push({ room_id: '!origin:example.org', name: 'Origin' } as RoomSummary);
  const instance = mount(ForwardedLine, {
    target: document.body,
    props: {
      forwarded: { timestamp: null, room_id: '!origin:example.org', event_id: '$event' },
      roomId: '!here:example.org',
    },
  });
  const link = document.querySelector('a');
  expect(link?.textContent.trim()).toBe('Forwarded from Origin');
  expect(link?.getAttribute('href')).toBe('/rooms/!origin:example.org?event=$event');
  await unmount(instance);
});

test('a forward from earlier in the room jumps in place', async () => {
  const onJumpToEvent = vi.fn();
  const instance = mount(ForwardedLine, {
    target: document.body,
    props: {
      forwarded: { timestamp: null, room_id: '!here:example.org', event_id: '$event' },
      roomId: '!here:example.org',
      onJumpToEvent,
    },
  });
  const button = document.querySelector('button');
  expect(button?.textContent.trim()).toBe('Forwarded from earlier');
  button?.click();
  expect(onJumpToEvent).toHaveBeenCalledWith('$event');
  await unmount(instance);
});

test('a private forward names no origin', async () => {
  const instance = mount(ForwardedLine, {
    target: document.body,
    props: {
      forwarded: { timestamp: null, room_id: null, event_id: null },
      roomId: '!here:example.org',
    },
  });
  expect(document.querySelector('a, button')).toBeNull();
  expect(document.body.textContent.trim()).toBe('Forwarded');
  await unmount(instance);
});
