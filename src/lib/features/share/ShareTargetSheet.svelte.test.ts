// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';

import type { RoomSummary } from '#src/generated/protocol';

vi.mock('#lib/core/context.js');

const mocks = vi.hoisted(() => ({
  afterOverlayPops: vi.fn(() => Promise.resolve()),
  rooms: [] as RoomSummary[],
}));

vi.mock('$app/navigation', () => import('#lib/test-support/app-navigation.js'));

import { goto } from '#lib/test-support/app-navigation.js';
vi.mock('$app/state', () => import('#lib/test-support/app-state.js'));
vi.mock('#lib/platform/overlay-back.svelte.js', () => ({
  afterOverlayPops: mocks.afterOverlayPops,
  holdOverlayBack: () => {},
}));
vi.mock('#lib/rooms/room-list.svelte.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('#lib/rooms/room-list.svelte.js')>()),
  useRoomList: () => ({ rooms: mocks.rooms, unreadFor: () => undefined }),
}));

import type { ShareInbox } from './share-inbox.svelte.js';
import ShareTargetSheet from './ShareTargetSheet.svelte';

afterEach(() => {
  mocks.rooms.length = 0;
  mocks.afterOverlayPops.mockReset();
});

test('picking a room navigates there only once the sheet has popped its history entry', async () => {
  mocks.rooms.push({
    room_id: '!a:example.org',
    name: 'Alpha',
    state: 'joined',
    latest_event: null,
  } as unknown as RoomSummary);
  let popped!: () => void;
  mocks.afterOverlayPops.mockReturnValue(
    new Promise<void>((resolve) => {
      popped = resolve;
    })
  );
  const clear = vi.fn(() => Promise.resolve());
  const inbox = {
    pending: true,
    text: '',
    fileCount: 1,
    files: () => Promise.resolve([new File(['x'], 'holiday.png', { type: 'image/png' })]),
    clear,
  } as unknown as ShareInbox;

  const user = userEvent.setup();
  render(ShareTargetSheet, { inbox });

  await user.click(await screen.findByRole('option', { name: /Alpha/ }));
  await vi.waitFor(() => {
    expect(mocks.afterOverlayPops).toHaveBeenCalled();
  });
  expect(clear).toHaveBeenCalled();
  expect(goto).not.toHaveBeenCalled();

  popped();
  await vi.waitFor(() => {
    expect(goto).toHaveBeenCalledWith(expect.stringContaining('/rooms/'), {
      replace: true,
    });
  });
});
