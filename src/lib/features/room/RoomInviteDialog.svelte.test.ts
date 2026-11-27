// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';

import type {
  InviteHistoryView,
  RoomListItemView,
  UserDirectoryEntryView,
} from '#src/generated/protocol';

vi.mock('#lib/core/context.js');

import { core as baseCore } from '#lib/core/__mocks__/context.js';

const searchUserDirectory =
  vi.fn<() => Promise<{ limited: boolean; results: UserDirectoryEntryView[] }>>();
const core = baseCore;
Object.assign(baseCore.rpc.rooms, {
  invite: vi.fn<(params: { room_id: string; user_id: string }) => Promise<InviteHistoryView>>(),
});
Object.assign(baseCore.rpc.account, { searchUserDirectory });

import RoomInviteDialog from './RoomInviteDialog.svelte';

const room = { room_id: '!room:example.org', name: 'Room', is_direct: false } as RoomListItemView;

afterEach(() => {
  vi.unstubAllGlobals();
});

test('suggests people from the directory and fills the picked one into the field before inviting', async () => {
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  searchUserDirectory.mockResolvedValue({
    limited: false,
    results: [
      {
        user_id: '@bob:example.org',
        display_name: 'Bob',
        avatar_url: null,
        real_name: 'Bob',
        real_avatar_url: null,
      },
    ],
  });
  core.rpc.rooms.invite.mockResolvedValue('not_shared');
  const user = userEvent.setup();
  render(RoomInviteDialog, { open: true, room, onOpenChange: () => {} });

  await user.type(await screen.findByRole('combobox', { name: 'Invite people' }), 'bo');

  const suggestion = await screen.findByRole('option', { name: /@bob:example\.org/ });
  expect(searchUserDirectory).toHaveBeenCalledWith({ term: 'bo', limit: 10 });

  await user.click(suggestion);
  expect(core.rpc.rooms.invite).not.toHaveBeenCalled();
  expect(screen.getByRole('combobox', { name: 'Invite people' })).toHaveValue('@bob:example.org');
  expect(screen.queryByRole('option', { name: /@bob:example\.org/ })).toBeNull();

  await user.click(screen.getByRole('button', { name: 'Invite' }));
  await vi.waitFor(() => {
    expect(core.rpc.rooms.invite).toHaveBeenCalledWith({
      room_id: '!room:example.org',
      user_id: '@bob:example.org',
    });
  });
});

test('picks a suggestion with the arrow keys and Enter', async () => {
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  searchUserDirectory.mockResolvedValue({
    limited: false,
    results: ['alice', 'bob'].map((name) => ({
      user_id: `@${name}:example.org`,
      display_name: name,
      avatar_url: null,
      real_name: name,
      real_avatar_url: null,
    })),
  });
  core.rpc.rooms.invite.mockClear();
  const user = userEvent.setup();
  render(RoomInviteDialog, { open: true, room, onOpenChange: () => {} });

  const field = await screen.findByRole('combobox', { name: 'Invite people' });
  await user.type(field, 'o');
  const bob = await screen.findByRole('option', { name: /@bob:example\.org/ });
  await user.keyboard('{ArrowDown}{ArrowDown}');
  expect(field).toHaveAttribute('aria-activedescendant', bob.id);
  await user.keyboard('{Enter}');

  expect(field).toHaveValue('@bob:example.org');
  expect(core.rpc.rooms.invite).not.toHaveBeenCalled();
});

const historyVisibility = vi.fn<() => Promise<string>>();
Object.assign(baseCore.rpc.room_state, { historyVisibility });
const encrypted = { ...room, encrypted: true } as RoomListItemView;

test('says next to the invite button that history goes with the invite', async () => {
  historyVisibility.mockResolvedValue('shared');
  core.rpc.rooms.invite.mockResolvedValue('shared');
  const user = userEvent.setup();
  render(RoomInviteDialog, { open: true, room: encrypted, onOpenChange: () => {} });

  expect(
    await screen.findByText(/Inviting can also give their verified sessions the keys/)
  ).toBeTruthy();

  await user.type(screen.getByRole('combobox', { name: 'Invite people' }), '@bob:example.org');
  await user.click(screen.getByRole('button', { name: 'Invite' }));
  expect(
    await screen.findByText(/Invited @bob:example\.org\. Once they join, their verified sessions/)
  ).toBeTruthy();
});

test('says the invite went out when its history could not be shared', async () => {
  historyVisibility.mockResolvedValue('shared');
  core.rpc.rooms.invite.mockResolvedValue('failed');
  const user = userEvent.setup();
  render(RoomInviteDialog, { open: true, room: encrypted, onOpenChange: () => {} });

  await user.type(
    await screen.findByRole('combobox', { name: 'Invite people' }),
    '@bob:example.org'
  );
  await user.click(screen.getByRole('button', { name: 'Invite' }));

  expect(
    await screen.findByText(
      /Invited @bob:example\.org, but this room’s past messages couldn’t be shared/
    )
  ).toBeTruthy();
});

test('says messages from the invite on are readable when history starts at the invite', async () => {
  historyVisibility.mockResolvedValue('invited');
  render(RoomInviteDialog, { open: true, room: encrypted, onOpenChange: () => {} });

  expect(await screen.findByText(/from the moment you invite them/)).toBeTruthy();
});

test('still warns about history when the setting cannot be read', async () => {
  historyVisibility.mockRejectedValue(new Error('offline'));
  render(RoomInviteDialog, { open: true, room: encrypted, onOpenChange: () => {} });

  expect(await screen.findByText(/Couldn’t check this room’s history setting/)).toBeTruthy();
});

const status = vi.fn(() => Promise.resolve({ verification: 'verified' }));
const userSecurity = vi.fn(() => Promise.resolve({ devices: [{ cross_signed: true }] }));
const userRelations = vi.fn(() =>
  Promise.resolve({ mutual_rooms: [{}] as unknown[], ignored: false })
);
Object.assign(baseCore.rpc.encryption, { status, userSecurity });
Object.assign(baseCore, { userRelations });

test('says history stays behind until cross-signing is set up', async () => {
  historyVisibility.mockResolvedValue('shared');
  status.mockResolvedValue({ verification: 'unknown' });
  render(RoomInviteDialog, { open: true, room: encrypted, onOpenChange: () => {} });

  expect(
    await screen.findByText(/won’t be shared with this invite until you set up cross-signing/)
  ).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Open security settings' })).toBeTruthy();
});

test('warns before handing history to a stranger with no verified sessions', async () => {
  historyVisibility.mockResolvedValue('shared');
  status.mockResolvedValue({ verification: 'verified' });
  userSecurity.mockResolvedValue({ devices: [{ cross_signed: false }] });
  userRelations.mockResolvedValue({ mutual_rooms: [], ignored: false });
  const user = userEvent.setup();
  render(RoomInviteDialog, { open: true, room: encrypted, onOpenChange: () => {} });

  await user.type(
    await screen.findByRole('combobox', { name: 'Invite people' }),
    '@eve:example.org'
  );

  expect(await screen.findByText(/You don’t share any rooms with @eve:example\.org/)).toBeTruthy();
  expect(screen.getByText(/@eve:example\.org has no verified sessions/)).toBeTruthy();
});
