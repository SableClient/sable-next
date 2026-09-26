// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';

import type { RoomSummary, UserDirectoryEntryView } from '#src/generated/protocol';

vi.mock('#lib/core/context.js');

import { core as baseCore } from '#lib/core/__mocks__/context.js';

const core = Object.assign(baseCore, {
  inviteUser: vi.fn<(roomId: string, userId: string) => Promise<void>>(),
  searchUserDirectory:
    vi.fn<() => Promise<{ limited: boolean; results: UserDirectoryEntryView[] }>>(),
});

import RoomInviteDialog from './RoomInviteDialog.svelte';

const room = { room_id: '!room:example.org', name: 'Room', is_direct: false } as RoomSummary;

afterEach(() => {
  vi.unstubAllGlobals();
});

test('suggests people from the directory and invites the one picked', async () => {
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  core.searchUserDirectory.mockResolvedValue({
    limited: false,
    results: [{ user_id: '@bob:example.org', display_name: 'Bob', avatar_url: null }],
  });
  core.inviteUser.mockResolvedValue(undefined);
  const user = userEvent.setup();
  render(RoomInviteDialog, { open: true, room, onOpenChange: () => {} });

  await user.type(await screen.findByRole('textbox', { name: 'Invite people' }), 'bo');

  const suggestion = await screen.findByRole('button', { name: /@bob:example\.org/ });
  expect(core.searchUserDirectory).toHaveBeenCalledWith('bo', 10);

  await user.click(suggestion);
  await vi.waitFor(() => {
    expect(core.inviteUser).toHaveBeenCalledWith('!room:example.org', '@bob:example.org');
  });
});
