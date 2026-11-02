// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';

import type { RoomListItemView } from '#src/generated/protocol';

vi.mock('#lib/core/context.js');

const mocks = vi.hoisted(() => ({
  afterOverlayPops: vi.fn(() => Promise.resolve()),
  rooms: [] as RoomListItemView[],
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
  useRoomList: () => ({
    rooms: mocks.rooms,
    unreadFor: () => undefined,
    whenListed: () => Promise.resolve(),
    byId: (roomId: string) => mocks.rooms.find((room) => room.room_id === roomId),
  }),
}));

import { core } from '#lib/core/__mocks__/context.js';

import type { ShareInbox } from './share-inbox.svelte.js';
import ShareTargetSheet from './ShareTargetSheet.svelte';

afterEach(() => {
  mocks.rooms.length = 0;
  mocks.afterOverlayPops.mockReset();
  vi.mocked(goto).mockClear();
  core.session = null;
  core.accounts = [];
});

function joined(roomId: string, name: string): void {
  mocks.rooms.push({
    room_id: roomId,
    name,
    state: 'joined',
    latest_event: null,
    display_name: name,
  } as unknown as RoomListItemView);
}

function targetedInbox(roomId: string, clear = vi.fn(() => Promise.resolve())) {
  return {
    pending: true,
    text: 'hello',
    fileCount: 0,
    target: { userId: '@other:example.org', roomId },
    files: () => Promise.resolve([]),
    clear,
  } as unknown as ShareInbox;
}

test('a conversation picked in the system share sheet opens on its account without the picker', async () => {
  joined('!picked:example.org', 'Picked');
  mocks.afterOverlayPops.mockResolvedValue(undefined);
  const switchAccount = vi.fn((accountId: string) => {
    core.session = { account_id: accountId, user_id: '@other:example.org' };
    return Promise.resolve();
  });
  Object.assign(core, {
    session: { account_id: 'me', user_id: '@me:example.org' },
    accounts: [
      { account_id: 'me', user_id: '@me:example.org' },
      { account_id: 'other', user_id: '@other:example.org' },
    ],
    switchAccount,
  });
  const clear = vi.fn(() => Promise.resolve());

  render(ShareTargetSheet, { inbox: targetedInbox('!picked:example.org', clear) });

  await vi.waitFor(() => {
    expect(goto).toHaveBeenCalledWith(expect.stringContaining('/rooms/'), { replace: true });
  });
  expect(switchAccount).toHaveBeenCalledWith('other');
  expect(clear).toHaveBeenCalled();
  expect(screen.queryByRole('option')).toBeNull();
});

test('a picked conversation the account no longer has falls back to the picker', async () => {
  joined('!kept:example.org', 'Kept');
  Object.assign(core, {
    session: { account_id: 'other', user_id: '@other:example.org' },
    accounts: [{ account_id: 'other', user_id: '@other:example.org' }],
  });

  render(ShareTargetSheet, { inbox: targetedInbox('!left:example.org') });

  expect(await screen.findByRole('option', { name: /Kept/ })).toBeTruthy();
  expect(goto).not.toHaveBeenCalled();
});

test('picking a room navigates there only once the sheet has popped its history entry', async () => {
  mocks.rooms.push({
    room_id: '!a:example.org',
    name: 'Alpha',
    state: 'joined',
    latest_event: null,
    display_name: 'Alpha',
  } as unknown as RoomListItemView);
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
