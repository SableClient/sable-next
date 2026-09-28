// @vitest-environment happy-dom

import { render } from '@testing-library/svelte';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import type { RoomSummary } from '#src/generated/protocol';

const state = vi.hoisted(() => ({ rooms: [] as RoomSummary[] }));
const rendered = vi.hoisted(() => [] as string[]);

vi.mock('$app/state', () => import('#lib/test-support/app-state.js'));
vi.mock('#lib/rooms/room-list.svelte.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useRoomList: () => state,
}));
vi.mock('#lib/features/room/RoomPage.svelte', () => ({
  default: () => rendered.push('room'),
}));
vi.mock('./ForumPage.svelte', () => ({
  default: () => rendered.push('forum'),
}));
vi.mock('#lib/features/calendar/CalendarPage.svelte', () => ({
  default: () => rendered.push('calendar'),
}));

import { visit } from '#lib/test-support/app-state.js';

import RoomOrForumPage from './RoomOrForumPage.svelte';

beforeEach(() => {
  state.rooms = [{ room_id: '!forum:example.org', room_type: 'pl.chrome.forum' } as RoomSummary];
  rendered.length = 0;
});

afterEach(() => {
  rendered.length = 0;
});

test('opens a forum in its event timeline when requested', () => {
  visit('/rooms/!forum:example.org?timeline=events', { roomId: '!forum:example.org' });
  render(RoomOrForumPage);

  expect(rendered).toEqual(['room']);
});

test('keeps a forum in its specialized view normally', () => {
  visit('/rooms/!forum:example.org', { roomId: '!forum:example.org' });
  render(RoomOrForumPage);

  expect(rendered).toEqual(['forum']);
});
