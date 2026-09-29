import { expect, test, vi } from 'vitest';

import type { ProfileView } from '#src/generated/protocol';
import type { CoreClient } from '#lib/core/client.svelte.js';

import { SenderDirectory } from './sender-directory.svelte.js';

function coreWithDirectory(searchUserDirectory: ReturnType<typeof vi.fn>): CoreClient {
  return {
    commands: { searchUserDirectory },
    userProfile: vi.fn().mockResolvedValue({ display_name: null, avatar_url: null }),
  } as unknown as CoreClient;
}

test('a name nobody has seen yet is looked up in the user directory', async () => {
  const searchUserDirectory = vi.fn().mockResolvedValue({
    limited: false,
    results: [{ user_id: '@bob:example.org', display_name: 'Bob', avatar_url: null }],
  });
  const senders = new SenderDirectory(coreWithDirectory(searchUserDirectory));

  expect(await senders.lookup('bob')).toBe(true);

  expect(searchUserDirectory).toHaveBeenCalledWith('bob', expect.any(Number));
  expect(senders.known()).toEqual([
    { userId: '@bob:example.org', displayName: 'Bob', avatarUrl: null },
  ]);
});

test('the same term is only looked up once, and a failure finds nobody', async () => {
  const searchUserDirectory = vi.fn().mockRejectedValue(new Error('offline'));
  const senders = new SenderDirectory(coreWithDirectory(searchUserDirectory));

  expect(await senders.lookup('bob')).toBe(false);
  expect(await senders.lookup('Bob ')).toBe(false);

  expect(searchUserDirectory).toHaveBeenCalledTimes(1);
  expect(senders.known()).toEqual([]);
});

test('a directory result loads its profile for search result styling', async () => {
  const core = coreWithDirectory(
    vi.fn().mockResolvedValue({
      limited: false,
      results: [{ user_id: '@bob:example.org', display_name: 'Bob', avatar_url: null }],
    })
  );
  vi.mocked(core.userProfile).mockResolvedValue({
    display_name: 'Bob',
    avatar_url: null,
    name_color_light: '#2f5a1f',
    name_color_dark: '#9fd07c',
    pronouns: [{ summary: 'they/them', language: null }],
  } as ProfileView);
  const senders = new SenderDirectory(core);
  await senders.lookup('bob');

  expect(senders.profile('@bob:example.org')).toBeNull();
  await vi.waitFor(() => {
    expect(senders.profile('@bob:example.org')?.pronouns?.[0]?.summary).toBe('they/them');
  });
  expect(core.userProfile).toHaveBeenCalledTimes(1);
});
