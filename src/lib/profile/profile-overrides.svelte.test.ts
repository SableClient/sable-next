import { afterEach, expect, test, vi } from 'vitest';

import type { CoreClient } from '#lib/core/client.svelte.js';

import {
  PROFILE_OVERRIDES_EVENT,
  profileOverrides,
  readOverrides,
  UNSTABLE_PROFILE_OVERRIDES_EVENT,
} from './profile-overrides.svelte';

function core(data: Record<string, unknown>) {
  const setAccountData = vi.fn(() => Promise.resolve());
  const client = {
    subscribeEvents: () => () => {},
    commands: {
      accountData: vi.fn((type: string) => Promise.resolve(data[type] ?? null)),
      setAccountData,
    },
  } as unknown as CoreClient;
  return { client, setAccountData };
}

afterEach(() => {
  profileOverrides.stop();
});

test('ignores keys that are not user ids and entries that are not objects', () => {
  expect(
    readOverrides({
      '@sarah:example.org': { displayname: 'Mum' },
      '#room:example.org': { displayname: 'nope' },
      '@alex:example.com': 'nope',
    })
  ).toEqual({ '@sarah:example.org': { displayname: 'Mum' } });
  expect(readOverrides({ encrypted: { iv: '', ciphertext: '', mac: '' } })).toEqual({});
});

test('an override replaces the name, and null shows the field as absent', async () => {
  const { client } = core({
    [UNSTABLE_PROFILE_OVERRIDES_EVENT]: {
      '@sarah:example.org': { displayname: 'Mum', avatar_url: 'mxc://example.org/mum' },
      '@alex:example.com': { displayname: null, 'eu.she-a.color': { on_light: '#112233' } },
    },
  });
  profileOverrides.start(client);
  await vi.waitFor(() => {
    expect(profileOverrides.of('@sarah:example.org')).toBeDefined();
  });

  expect(profileOverrides.name('@sarah:example.org', 'Sarah')).toBe('Mum');
  expect(profileOverrides.avatar('@sarah:example.org', null)).toBe('mxc://example.org/mum');
  expect(profileOverrides.name('@alex:example.com', 'Alex')).toBe('@alex:example.com');
  expect(profileOverrides.colors('@alex:example.com')).toEqual({ light: '#112233', dark: null });
  expect(profileOverrides.name('@nobody:example.org', 'Nobody')).toBe('Nobody');
});

test('the stable event wins, and saving writes back to the type it was read from', async () => {
  const { client, setAccountData } = core({
    [PROFILE_OVERRIDES_EVENT]: { '@sarah:example.org': { displayname: 'Mum' } },
    [UNSTABLE_PROFILE_OVERRIDES_EVENT]: { '@sarah:example.org': { displayname: 'Old' } },
  });
  profileOverrides.start(client);
  await vi.waitFor(() => {
    expect(profileOverrides.name('@sarah:example.org', 'Sarah')).toBe('Mum');
  });

  await profileOverrides.set('@sarah:example.org', { displayname: undefined });

  expect(setAccountData).toHaveBeenCalledWith(PROFILE_OVERRIDES_EVENT, {});
  expect(profileOverrides.of('@sarah:example.org')).toBeUndefined();
});

test('saving keeps fields this client does not edit', async () => {
  const { client, setAccountData } = core({
    [UNSTABLE_PROFILE_OVERRIDES_EVENT]: { '@alex:example.com': { 'm.tz': 'Europe/Paris' } },
  });
  profileOverrides.start(client);
  await vi.waitFor(() => {
    expect(profileOverrides.of('@alex:example.com')).toBeDefined();
  });

  await profileOverrides.set('@alex:example.com', { displayname: 'Alex (accounting)' });

  expect(setAccountData).toHaveBeenCalledWith(UNSTABLE_PROFILE_OVERRIDES_EVENT, {
    '@alex:example.com': { 'm.tz': 'Europe/Paris', displayname: 'Alex (accounting)' },
  });
});
