// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { expect, test, vi } from 'vitest';

import { asWireItems } from '#lib/test-support/timeline-wire.js';
import type { BookmarkView, TimelineItemView } from '#src/generated/protocol';

vi.mock('#lib/core/context.js');
vi.mock('#lib/rooms/room-list.svelte.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useRoomList: () => ({ rooms: [], byId: () => undefined }),
}));
vi.mock('#lib/personas/personas.svelte.js', () => ({
  usePersonaStore: () => ({ personas: [], load: () => Promise.resolve() }),
}));
vi.mock('#lib/rooms/presence.svelte.js', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  usePresenceStore: () => ({ get: () => null }),
}));

import { core } from '#lib/core/__mocks__/context.js';
import { item } from '../room/timeline/timeline-item-fixtures';
import BookmarkListHarness from './BookmarkListHarness.test.svelte';

test('a cold bookmark preview keeps its room sender and loads global colors without revisiting', async () => {
  const event = Promise.withResolvers<TimelineItemView[]>();
  const profile = Promise.withResolvers<unknown>();
  core.rpc.account.bookmarks.mockResolvedValue([
    {
      bookmark_id: 'saved',
      room_id: '!left:example.org',
      room_name: 'Former room',
      event_id: '$item',
      sender: '@alice:example.org',
      body_preview: 'Fallback body',
      event_ts: 0,
      bookmarked_ts: 0,
    } satisfies BookmarkView,
  ]);
  core.rpc.timeline.eventItems.mockReturnValue(event.promise);
  core.userProfile.mockReturnValue(profile.promise);
  core.rpc.rooms.cosmetics.mockResolvedValue({ users: [], space_id: null });
  render(BookmarkListHarness);

  await screen.findByText('Former room');
  await vi.waitFor(() => {
    expect(core.rpc.timeline.eventItems).toHaveBeenCalled();
  });
  event.resolve(asWireItems([{ ...item(false), sender_name: 'Room Alice' }]));
  await screen.findByText('waves');
  await screen.findByText('Room Alice');
  profile.resolve({ display_name: 'Alice on the bridge', name_color_light: '#2244aa' });

  await vi.waitFor(() => {
    const name = document.querySelector<HTMLElement>('.message .sender-identity-name');
    expect(name?.style.getPropertyValue('--name-color-on-light')).toBe('#2244aa');
    expect(name?.textContent).toBe('Room Alice');
  });
});
