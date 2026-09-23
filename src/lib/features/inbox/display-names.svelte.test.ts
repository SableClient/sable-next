import { expect, test, vi } from 'vitest';

import type { ProfileView } from '#src/generated/protocol';

import { DisplayNames } from './display-names.svelte';

test('shows the localpart until the profile resolves, then the display name', async () => {
  const userProfile = vi.fn(() =>
    Promise.resolve({ user_id: '@ada:example.org', display_name: 'Ada Lovelace' } as ProfileView)
  );
  const names = new DisplayNames({ userProfile });

  expect(names.name('@ada:example.org')).toBe('ada');
  await vi.waitFor(() => {
    expect(names.name('@ada:example.org')).toBe('Ada Lovelace');
  });
  expect(userProfile).toHaveBeenCalledOnce();
});

test('keeps the localpart when the profile has no name or fails', async () => {
  const names = new DisplayNames({ userProfile: vi.fn(() => Promise.reject(new Error('gone'))) });

  names.name('@bot:example.org');
  await Promise.resolve();

  expect(names.name('@bot:example.org')).toBe('bot');
});
