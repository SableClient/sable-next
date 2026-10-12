import { afterEach, expect, test, vi } from 'vitest';

import type { ProfileOverridesView } from '#src/generated/protocol';
import type { CoreClient } from '#lib/core/client.svelte.js';

import { profileOverrides } from './profile-overrides.svelte';

function core(view: ProfileOverridesView) {
  const setProfileOverride = vi.fn(() => Promise.resolve(view));
  const client = {
    subscribeEvents: () => () => {},
    commands: {
      profileOverrides: vi.fn(() => Promise.resolve(view)),
      setProfileOverride,
    },
  } as unknown as CoreClient;
  return { client, setProfileOverride };
}

const overrides: ProfileOverridesView = {
  protection: 'sealed',
  can_seal: true,
  overrides: [
    {
      user_id: '@sarah:example.org',
      display_name: { kind: 'set', value: 'Mum' },
      avatar: { kind: 'set', value: 'mxc://example.org/mum' },
      color: { kind: 'unset' },
    },
    {
      user_id: '@alex:example.com',
      display_name: { kind: 'cleared' },
      avatar: { kind: 'cleared' },
      color: { kind: 'set', light: '#112233', dark: null },
    },
  ],
};

afterEach(() => {
  profileOverrides.stop();
});

test('an override replaces a field, and a cleared one shows it as absent', async () => {
  profileOverrides.start(core(overrides).client);
  await vi.waitFor(() => {
    expect(profileOverrides.of('@sarah:example.org')).toBeDefined();
  });

  expect(profileOverrides.name('@sarah:example.org', 'Sarah')).toBe('Mum');
  expect(profileOverrides.avatar('@sarah:example.org', null)).toBe('mxc://example.org/mum');
  expect(profileOverrides.colors('@sarah:example.org')).toBeUndefined();
  expect(profileOverrides.name('@alex:example.com', 'Alex')).toBe('@alex:example.com');
  expect(profileOverrides.avatar('@alex:example.com', 'mxc://example.org/real')).toBeNull();
  expect(profileOverrides.colors('@alex:example.com')).toEqual({ light: '#112233', dark: null });
  expect(profileOverrides.name('@nobody:example.org', 'Nobody')).toBe('Nobody');
  expect(profileOverrides.protection).toBe('sealed');
  expect(profileOverrides.canSeal).toBe(true);
});

test('saving hands the edit to the core and adopts what it stored', async () => {
  const { client, setProfileOverride } = core({ ...overrides, overrides: [] });
  profileOverrides.start(client);
  const edit = {
    display_name: { kind: 'clear' },
    avatar: { kind: 'clear' },
    color: { kind: 'clear' },
  } as const;

  await profileOverrides.set('@sarah:example.org', edit);

  expect(setProfileOverride).toHaveBeenCalledWith('@sarah:example.org', edit);
  expect(profileOverrides.of('@sarah:example.org')).toBeUndefined();
});
