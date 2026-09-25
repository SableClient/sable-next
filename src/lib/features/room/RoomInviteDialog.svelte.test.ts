// @vitest-environment happy-dom

import { mount, unmount } from 'svelte';
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
  document.body.replaceChildren();
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
  const instance = mount(RoomInviteDialog, {
    target: document.body,
    props: { open: true, room, onOpenChange: () => {} },
  });

  const input = await vi.waitFor(() => {
    const found = document.querySelector<HTMLInputElement>('#room-invite-user');
    if (!found) throw new Error('invite input missing');
    return found;
  });
  input.value = 'bo';
  input.dispatchEvent(new Event('input', { bubbles: true }));

  const suggestion = await vi.waitFor(() => {
    expect(core.searchUserDirectory).toHaveBeenCalledWith('bo', 10);
    const found = document.querySelector<HTMLButtonElement>('.suggestions button');
    if (!found) throw new Error('suggestion missing');
    return found;
  });
  expect(suggestion.textContent).toContain('@bob:example.org');

  suggestion.click();
  await vi.waitFor(() => {
    expect(core.inviteUser).toHaveBeenCalledWith('!room:example.org', '@bob:example.org');
  });

  await unmount(instance);
});
