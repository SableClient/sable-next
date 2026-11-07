// @vitest-environment happy-dom

import { fireEvent, render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { afterEach, assert, beforeEach, expect, test, vi } from 'vitest';
import type { RoomListItemView } from '#src/generated/protocol';

vi.mock('$app/navigation', () => import('#lib/test-support/app-navigation.js'));
vi.mock('#lib/core/context.js');
const roomList = vi.hoisted(() => ({ rooms: [] as RoomListItemView[], settled: true }));
vi.mock('#lib/rooms/room-list.svelte.js', async (original) => ({
  ...(await original<typeof import('#lib/rooms/room-list.svelte.js')>()),
  useRoomList: () => roomList,
}));

import { core } from '#lib/core/__mocks__/context.js';
import { goto } from '#lib/test-support/app-navigation.js';
import { i18n } from '#lib/i18n.js';
import UserLinkCard from './UserLinkCard.svelte';

beforeEach(() => {
  core.userProfile.mockResolvedValue({ display_name: 'Alice', avatar_url: null });
  core.rpc.rooms.createDm.mockResolvedValue('!new:example.org');
});
afterEach(() => {
  roomList.rooms = [];
  roomList.settled = true;
  core.rpc.rooms.createDm.mockReset();
});

test('waits for the room list before deciding whether to create a DM', async () => {
  roomList.settled = false;
  render(UserLinkCard, { props: { userId: '@alice:example.org', startChat: true } });
  await screen.findByRole('heading', { name: 'Alice' });

  expect(screen.queryByRole('dialog')).toBeNull();
  expect(core.rpc.rooms.createDm).not.toHaveBeenCalled();
});

test('a chat action asks before creating a DM, then navigates after confirmation', async () => {
  render(UserLinkCard, { props: { userId: '@alice:example.org', startChat: true } });
  await screen.findByRole('dialog');
  expect(core.rpc.rooms.createDm).not.toHaveBeenCalled();
  const form = screen.getByRole('button', { name: i18n.t('direct.submit') }).closest('form');
  assert(form);
  await fireEvent.submit(form);
  await vi.waitFor(() => {
    expect(core.rpc.rooms.createDm).toHaveBeenCalledWith({
      user_id: '@alice:example.org',
      encrypted: null,
      encrypt_new: true,
    });
  });
  await vi.waitFor(() => {
    expect(goto).toHaveBeenCalled();
  });
});

test('a user URI without a chat action displays a profile without opening a DM', async () => {
  render(UserLinkCard, { props: { userId: '@alice:example.org' } });
  await screen.findByRole('heading', { name: 'Alice' });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(core.rpc.rooms.createDm).not.toHaveBeenCalled();
  expect(goto.mock.calls.some(([path]) => path.startsWith('/direct/'))).toBe(false);
});

test('cancelling a chat action leaves the profile open without creating a room', async () => {
  render(UserLinkCard, { props: { userId: '@alice:example.org', startChat: true } });
  await screen.findByRole('dialog');
  await userEvent.click(screen.getByRole('button', { name: i18n.t('common.cancel') }));
  await vi.waitFor(() => {
    expect(screen.queryByRole('dialog')).toBeNull();
  });
  expect(core.rpc.rooms.createDm).not.toHaveBeenCalled();
  expect(goto.mock.calls.some(([path]) => path.startsWith('/direct/'))).toBe(false);
});

test('a cancelled chat action is not asked again when the room list reconnects', async () => {
  const { rerender } = render(UserLinkCard, {
    props: { userId: '@alice:example.org', startChat: true },
  });
  await screen.findByRole('dialog');
  await userEvent.click(screen.getByRole('button', { name: i18n.t('common.cancel') }));
  await vi.waitFor(() => {
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  roomList.settled = false;
  await rerender({ userId: '@alice:example.org', startChat: true });
  roomList.settled = true;
  await rerender({ userId: '@alice:example.org', startChat: true });

  expect(screen.queryByRole('dialog')).toBeNull();
});

test('a chat action opens an existing joined DM without creating one or asking again', async () => {
  roomList.rooms = [
    {
      room_id: '!dm:example.org',
      canonical_alias: null,
      state: 'joined',
      is_direct: true,
      is_tombstoned: false,
      direct_targets: ['@alice:example.org'],
    } as RoomListItemView,
  ];
  render(UserLinkCard, { props: { userId: '@alice:example.org', startChat: true } });
  await vi.waitFor(() => {
    expect(goto).toHaveBeenCalledWith('/direct/!dm%3Aexample.org', { replace: true });
  });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(core.rpc.rooms.createDm).not.toHaveBeenCalled();
});
