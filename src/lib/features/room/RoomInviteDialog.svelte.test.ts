// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';

import type { RoomListItemView, UserDirectoryEntryView } from '#src/generated/protocol';

vi.mock('#lib/core/context.js');

import { core as baseCore } from '#lib/core/__mocks__/context.js';

const searchUserDirectory =
  vi.fn<() => Promise<{ limited: boolean; results: UserDirectoryEntryView[] }>>();
const core = baseCore;
Object.assign(baseCore.rpc.rooms, {
  invite: vi.fn<(params: { room_id: string; user_id: string }) => Promise<null>>(),
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
  core.rpc.rooms.invite.mockResolvedValue(null);
  const user = userEvent.setup();
  render(RoomInviteDialog, { open: true, room, onOpenChange: () => {} });

  await user.type(await screen.findByRole('textbox', { name: 'Invite people' }), 'bo');

  const suggestion = await screen.findByRole('button', { name: /@bob:example\.org/ });
  expect(searchUserDirectory).toHaveBeenCalledWith({ term: 'bo', limit: 10 });

  await user.click(suggestion);
  expect(core.rpc.rooms.invite).not.toHaveBeenCalled();
  expect(screen.getByRole('textbox', { name: 'Invite people' })).toHaveValue('@bob:example.org');
  expect(screen.queryByRole('button', { name: /@bob:example\.org/ })).toBeNull();

  await user.click(screen.getByRole('button', { name: 'Invite' }));
  await vi.waitFor(() => {
    expect(core.rpc.rooms.invite).toHaveBeenCalledWith({
      room_id: '!room:example.org',
      user_id: '@bob:example.org',
    });
  });
});
