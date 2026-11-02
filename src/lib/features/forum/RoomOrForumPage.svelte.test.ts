// @vitest-environment happy-dom

import { render } from '@testing-library/svelte';
import { tick } from 'svelte';
import type { Window as HappyDOMWindow } from 'happy-dom';
import { afterEach, beforeEach, expect, onTestFinished, test, vi } from 'vitest';

import type { RoomListItemView } from '#src/generated/protocol';

const state = vi.hoisted(() => ({ rooms: [] as RoomListItemView[] }));
const rendered = vi.hoisted(() => [] as string[]);

vi.mock('$app/state', () => import('#lib/test-support/app-state.js'));
vi.mock('#lib/core/context.js');
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
const openConversation = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock('#lib/platform/native-notifications.js', () => ({
  setNativeOpenConversation: openConversation,
}));
vi.mock('#lib/features/calendar/CalendarPage.svelte', () => ({
  default: () => rendered.push('calendar'),
}));

import { page, visit } from '#lib/test-support/app-state.js';

import RoomOrForumPage from './RoomOrForumPage.svelte';

beforeEach(() => {
  state.rooms = [
    { room_id: '!forum:example.org', room_kind: 'forum' } as unknown as RoomListItemView,
  ];
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

test('a forum permalink uses the room event navigation', () => {
  visit('/rooms/!forum:example.org?event=%24reply', { roomId: '!forum:example.org' });
  render(RoomOrForumPage);
  expect(rendered).toEqual(['room']);
});

test('landing on a notification keeps the room mounted when its state is cleared', async () => {
  const pageState = $state<{ notified?: string }>({ notified: '$event' });
  Object.defineProperty(page, 'state', { configurable: true, get: () => pageState });
  state.rooms = [
    { room_id: '!room:example.org', room_kind: 'text' } as unknown as RoomListItemView,
  ];
  visit('/rooms/!room:example.org', { roomId: '!room:example.org' });
  render(RoomOrForumPage);
  expect(rendered).toEqual(['room']);

  pageState.notified = undefined;
  await tick();

  expect(rendered).toEqual(['room']);
});

test('a room behind the open mobile drawer is not the open conversation until the drawer closes', async () => {
  const happyDOM = (window as unknown as HappyDOMWindow).happyDOM;
  const size = { width: window.innerWidth, height: window.innerHeight };
  happyDOM.setViewport({ width: 390, height: 844 });
  onTestFinished(() => {
    happyDOM.setViewport(size);
  });
  const pageState = $state<App.PageState>({ mobileDrawer: 'open' });
  Object.defineProperty(page, 'state', { configurable: true, get: () => pageState });
  state.rooms = [
    { room_id: '!room:example.org', room_kind: 'text' } as unknown as RoomListItemView,
  ];
  visit('/rooms/!room:example.org', { roomId: '!room:example.org' });
  render(RoomOrForumPage);
  await tick();
  expect(openConversation).toHaveBeenLastCalledWith(null, null);

  pageState.mobileDrawer = 'closed';
  await tick();

  expect(openConversation).toHaveBeenLastCalledWith(null, '!room:example.org');
});
