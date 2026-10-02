import { afterEach, expect, test, vi } from 'vitest';

import type { CoreClient } from '#lib/core/client.svelte.js';

import {
  PROFILE_OVERRIDES_EVENT,
  profileOverrides,
  readOverrides,
  UNSTABLE_PROFILE_OVERRIDES_EVENT,
} from './profile-overrides.svelte';

function core(
  data: Record<string, unknown>,
  seal: { state: 'plain' | 'sealed' | 'locked'; can_seal: boolean } = {
    state: 'plain',
    can_seal: false,
  }
) {
  const setAccountData = vi.fn(() => Promise.resolve());
  const setSealedAccountData = vi.fn(() => Promise.resolve());
  const client = {
    subscribeEvents: () => () => {},
    commands: {
      accountData: vi.fn((type: string) => Promise.resolve(data[type] ?? null)),
      sealedAccountData: vi.fn((type: string) =>
        Promise.resolve({ content: data[type] ?? null, ...seal })
      ),
      setAccountData,
      setSealedAccountData,
    },
  } as unknown as CoreClient;
  return { client, setAccountData, setSealedAccountData };
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
  const { client, setSealedAccountData } = core({
    [UNSTABLE_PROFILE_OVERRIDES_EVENT]: { '@alex:example.com': { 'm.tz': 'Europe/Paris' } },
  });
  profileOverrides.start(client);
  await vi.waitFor(() => {
    expect(profileOverrides.of('@alex:example.com')).toBeDefined();
  });

  await profileOverrides.set('@alex:example.com', { displayname: 'Alex (accounting)' });

  expect(setSealedAccountData).toHaveBeenCalledWith(UNSTABLE_PROFILE_OVERRIDES_EVENT, {
    '@alex:example.com': { 'm.tz': 'Europe/Paris', displayname: 'Alex (accounting)' },
  });
});

test('an encrypted avatar is shown as its file object, and plaintext is resealed', async () => {
  const file = {
    v: 'v2',
    iv: 'iv',
    hashes: { sha256: 'hash' },
    key: { k: 'key', kty: 'oct' },
    url: 'mxc://example.org/enc',
  };
  const { client, setSealedAccountData } = core(
    { [UNSTABLE_PROFILE_OVERRIDES_EVENT]: { '@sarah:example.org': { avatar_url: file } } },
    { state: 'plain', can_seal: true }
  );
  profileOverrides.start(client);
  await vi.waitFor(() => {
    expect(setSealedAccountData).toHaveBeenCalledTimes(1);
  });

  const source = profileOverrides.avatar('@sarah:example.org', null);
  expect(JSON.parse(source ?? '')).toMatchObject({ url: file.url });
});

test('a locked document is empty and refuses edits', async () => {
  const { client, setSealedAccountData } = core(
    { [UNSTABLE_PROFILE_OVERRIDES_EVENT]: null },
    { state: 'locked', can_seal: false }
  );
  profileOverrides.start(client);
  await vi.waitFor(() => {
    expect(profileOverrides.protection).toBe('locked');
  });

  await expect(profileOverrides.set('@a:b.c', { displayname: 'x' })).rejects.toThrow();
  expect(setSealedAccountData).not.toHaveBeenCalled();
});
